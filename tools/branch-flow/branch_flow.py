#!/usr/bin/env python3
"""Stacked pull requests for Orca workspaces, run on request only.

Nothing here runs automatically: Orca creates workspaces and names branches as usual
(the owner chooses), commits are not pushed, and no PR opens by itself. When the owner
asks, these commands push a branch and open a draft PR into its parent branch, and keep
a stack of PRs (child -> parent -> main) in order.

The parent of a branch is, in order: the one recorded with `git parent --set` (or by
`publish --base`, `new`, `ship`), the branch of the Orca parent workspace when the branch
is based on it, otherwise the default branch.

Commands:
  publish        Push the current branch and open/update its draft PR into the parent
                 (with branchflow.stackPrs, default on, the PRs of its ancestors too).
  sync-parent    Merge the latest parent branch into the current branch and push it.
  parent         Print (or --set) the parent branch of the current branch.
  new            Create an Orca workspace for a stacked child (based on the parent's branch).
  ship           Move this workspace's uncommitted changes into a new (or existing) child
                 workspace, possibly nested (ship Bugs "Bug 1"), commit and publish there.
  status         Read-only tree of one project's workspaces, branches and PRs (git flow-status).
  restore        Recreate a deleted Orca workspace on its existing branch and PR.
  abandon        Drop a task: close its PR, delete its GitHub branch, remove the worktree.
  reconcile      On request: after merges on GitHub, sync stacked branches and refresh
                 their PRs (--delete-branches also deletes finished GitHub branches).
  pre-push       Git pre-push hook: no force-push, no deletion of remote branches.

  install        Copy this script to the user data directory and add git commands
                 (also removes the old reconcile crontab line).
  install-repo   Add the pre-push guard to one repository (and remove old automation).
  uninstall-repo Remove what install-repo added (only files carrying the marker).
  uninstall      Remove what install added (only files carrying the marker).
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

MARKER = 'orca-branch-flow'
ZERO = '0' * 40
HOME = Path(os.environ.get('HOME', '~')).expanduser()
DATA = HOME / '.local/share/orca-branch-flow'
BIN = HOME / '.local/bin'
COMMANDS = {'git-publish': 'publish', 'git-sync-parent': 'sync-parent', 'git-parent': 'parent',
            'git-abandon': 'abandon', 'git-restore-workspace': 'restore',
            'git-flow-status': 'status', 'git-flow-help': 'menu', 'git-new-workspace': 'new',
            'git-ship': 'ship'}
BLOCK_START = '<!-- branch-flow:start -->'
BLOCK_END = '<!-- branch-flow:end -->'
ORPHAN_NOTE = '⚠ **Workspace удалён на сервере.**'
PLACEHOLDER = 'chore: open stack PR'
STATE = HOME / '.local/state'
PR_FIELDS = 'number,title,state,isDraft,url,baseRefName,headRefName,body'
HOOK = f"""#!/bin/sh
# {MARKER}: no force-push, no deletion of remote branches. Owner-only bypass: --no-verify
exec python3 "$HOME/.local/share/orca-branch-flow/branch_flow.py" pre-push "$@"
"""
# Left by older versions (automatic setup hook, auto-push, auto-PR, cron); removed on install.
LEGACY_FILES = ('orca.yaml', '.worktreeinclude')
LEGACY_HOOKS = ('post-commit',)
LEGACY_CONFIG = ('branchflow.autoPush', 'branchflow.autoPr', 'branchflow.cleanup')

RULES = ('the guard refuses force-pushes and deletion of GitHub branches. Do not bypass it; '
         'report it to the owner.')


class FlowError(Exception):
    pass


def git(*args, cwd=None, check=True):
    r = subprocess.run(['git', *args], cwd=cwd, text=True, capture_output=True)
    if check and r.returncode:
        raise FlowError(f"git {' '.join(args)}: {r.stderr.strip() or r.stdout.strip()}")
    return r.stdout.strip()


def git_ok(*args, cwd=None):
    return subprocess.run(['git', *args], cwd=cwd, capture_output=True).returncode == 0


def say(msg):
    print(f'[branch-flow] {msg}', flush=True)


def current_branch(cwd=None):
    return git('branch', '--show-current', cwd=cwd)


def default_branch(cwd=None):
    ref = git('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD', cwd=cwd, check=False)
    if ref:
        return ref.rsplit('refs/remotes/origin/', 1)[-1]
    for name in ('main', 'master'):
        if git_ok('rev-parse', '--verify', '--quiet', f'refs/heads/{name}', cwd=cwd):
            return name
    return 'main'


def has_origin(cwd=None):
    return bool(git('remote', 'get-url', 'origin', cwd=cwd, check=False))


def ref_exists(ref, cwd=None):
    return git_ok('rev-parse', '--verify', '--quiet', ref + '^{commit}', cwd=cwd)


def orca_cli():
    cmd = os.environ.get('ORCA_CLI_COMMAND')
    if cmd:
        return cmd
    for name in ('orca-ide', 'orca'):
        path = shutil.which(name)
        if not path and (BIN / name).exists():
            path = str(BIN / name)
        # /usr/bin/orca is usually the GNOME screen reader, never the Orca CLI.
        if path and not path.startswith(('/usr/bin/', '/bin/')):
            return path
    return None


def orca_json(*args):
    cli = orca_cli()
    if not cli:
        return None
    try:
        r = subprocess.run([cli, *args, '--json'], text=True, capture_output=True, timeout=20)
        data = json.loads(r.stdout or 'null')
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None
    return data.get('result') if isinstance(data, dict) and data.get('ok') else None


def orca_worktree(path):
    res = orca_json('worktree', 'show', '--worktree', f'path:{path}')
    return (res or {}).get('worktree')


def is_workspace(path):
    """Created as a workspace by Orca (not just a git worktree Orca happens to list)."""
    return bool((orca_worktree(path) or {}).get('createdAt'))


def orca_parent_branch(top):
    """Branch of the Orca parent worktree, if it is a worktree of the same repository."""
    wt = orca_worktree(top)
    if not wt or not wt.get('parentWorktreeId'):
        return None
    repo_id, _, parent_path = wt['parentWorktreeId'].partition('::')
    if repo_id != wt.get('repoId') or not parent_path:
        return None
    parent = orca_worktree(parent_path)
    branch = (parent or {}).get('branch') or ''
    if not branch and Path(parent_path).is_dir():
        branch = current_branch(parent_path)
    return branch.removeprefix('refs/heads/') or None


def parent_of(branch, top, ask_orca=True):
    """Recorded parent; else the Orca parent workspace's branch if branch is based on it;
    else the default branch."""
    saved = git('config', '--get', f'branch.{branch}.orcaParent', cwd=top, check=False)
    if saved:
        return saved
    found = orca_parent_branch(top) if ask_orca else None
    if found and found != branch and based_on(branch, found, top):
        return found
    return default_branch(top)


def first_ref(branch, top):
    for ref in (f'refs/heads/{branch}', f'refs/remotes/origin/{branch}'):
        if ref_exists(ref, top):
            return ref
    return None


def based_on(branch, parent, top):
    """Was branch started from parent (it contains parent's tip, or commits that parent
    has beyond the default branch)? A workspace created from main under an Orca parent is not."""
    b, p, d = first_ref(branch, top), first_ref(parent, top), first_ref(default_branch(top), top)
    if not b or not p:
        return False
    if git_ok('merge-base', '--is-ancestor', p, b, cwd=top):
        return True
    mb = git('merge-base', p, b, cwd=top, check=False)
    return bool(mb and d) and not git_ok('merge-base', '--is-ancestor', mb, d, cwd=top)


def record_workspace(branch, path, top):
    """Remember that an Orca workspace owned this branch (kept after the branch is deleted)."""
    git('config', f'orcaworkspace.{branch}.path', str(path), cwd=top)


def workspace_records(top):
    out = {}
    for line in git('config', '--get-regexp', r'^orcaworkspace\..*\.path$', cwd=top, check=False).splitlines():
        key, _, path = line.partition(' ')
        out[key.removeprefix('orcaworkspace.').removesuffix('.path')] = path
    return out


def worktree_branches(top):
    out = set()
    for line in git('worktree', 'list', '--porcelain', cwd=top).splitlines():
        if line.startswith('branch refs/heads/'):
            out.add(line.removeprefix('branch refs/heads/'))
    return out


def orphaned(b, top):
    return b in workspace_records(top) and b not in worktree_branches(top)


def record_parent(branch, parent, top):
    """Store the parent of a stacked branch; also point Orca's compare base (branch.<b>.base) at it."""
    git('config', f'branch.{branch}.orcaParent', parent, cwd=top)
    ref = first_ref(parent, top)
    if ref:
        git('config', '--replace-all', f'branch.{branch}.base', ref, cwd=top)


def stacked(branch, top):
    """Has a recorded parent: published, created or shipped by this tool, or `git parent --set`."""
    return bool(git('config', '--get', f'branch.{branch}.orcaParent', cwd=top, check=False))


def toplevel():
    try:
        return git('rev-parse', '--show-toplevel')
    except FlowError:
        raise FlowError('not inside a git worktree')


def task_branch(top):
    b = current_branch(top)
    if not b:
        raise FlowError('detached HEAD: check out a task branch first')
    return b


def gh_json(*args, cwd=None):
    r = subprocess.run(['gh', *args], cwd=cwd, text=True, capture_output=True)
    if r.returncode:
        raise FlowError(f"gh {' '.join(args)}: {r.stderr.strip()}")
    return json.loads(r.stdout or 'null')


def remote_has(branch, cwd):
    return bool(git('ls-remote', '--heads', 'origin', f'refs/heads/{branch}', cwd=cwd))


def live_parent(branch, top):
    """Parent branch, moving up past parents whose PRs were merged and deleted on GitHub."""
    parent = parent_for(branch, top)
    default = default_branch(top)
    seen = set()
    while has_origin(top) and parent not in (default, branch) and parent not in seen and not remote_has(parent, top):
        seen.add(parent)
        try:
            merged = gh_json('pr', 'list', '--head', parent, '--state', 'merged', '--json', 'baseRefName', cwd=top)
        except FlowError:
            break
        if not merged:
            break
        say(f"parent {parent} was merged into {merged[0]['baseRefName']}; using that as parent")
        parent = merged[0]['baseRefName']
        record_parent(branch, parent, top)
    return parent


def push(top, *refspec_args):
    return subprocess.run(['git', 'push', *refspec_args], cwd=top).returncode == 0


def ensure_parent_on_github(parent, top):
    if parent == default_branch(top) or remote_has(parent, top):
        return
    if not ref_exists(f'refs/heads/{parent}', top):
        raise FlowError(f'parent {parent} exists neither locally nor on GitHub; set one with `git parent --set`')
    say(f'parent {parent} is not on GitHub yet: pushing it under the same name (no PR)')
    if not push(top, '--set-upstream', 'origin', f'refs/heads/{parent}:refs/heads/{parent}'):
        raise FlowError(f'could not push parent {parent}')


# --- pull request text --------------------------------------------------------------

def humanize(branch):
    text = branch.rsplit('/', 1)[-1].replace('-', ' ').replace('_', ' ').strip()
    return text[:1].upper() + text[1:]


def orca_info(branch, top):
    wt = worktree_of(branch, top)
    info = orca_worktree(wt) if wt and orca_cli() else None
    return info if info and not info.get('isMainWorktree') else None


def display_name(branch, top):
    return (orca_info(branch, top) or {}).get('displayName') or humanize(branch)


def parent_for(branch, top):
    wt = worktree_of(branch, top)
    return parent_of(branch, wt or top, ask_orca=bool(wt))


def open_pr(branch, top):
    prs = gh_json('pr', 'list', '--head', branch, '--state', 'open', '--json', PR_FIELDS, cwd=top)
    return prs[0] if prs else None


def api_patch_pr(number, top, **fields):
    args = ['gh', 'api', '-X', 'PATCH', f'repos/{{owner}}/{{repo}}/pulls/{number}']
    for key, value in fields.items():
        args += ['-f', f'{key}={value}']
    r = subprocess.run(args, cwd=top, text=True, capture_output=True)
    if r.returncode:
        raise FlowError(f'updating PR #{number} failed: {r.stderr.strip()}')


def state_word(pr):
    if pr['state'] == 'MERGED':
        return 'влит'
    if pr['state'] == 'CLOSED':
        return 'закрыт'
    return 'draft' if pr.get('isDraft') else 'открыт'


def format_children(prs):
    lines = []
    for pr in sorted(prs, key=lambda p: p['number']):
        if pr['state'] == 'CLOSED':
            continue
        box = 'x' if pr['state'] == 'MERGED' else ' '
        lines.append(f"- [{box}] #{pr['number']} {pr['title']} · {state_word(pr)}")
    return lines


def format_history(prs, current):
    old = [p for p in sorted(prs, key=lambda p: p['number']) if p['number'] != current]
    return ', '.join(f"#{p['number']} ({state_word(p)})" for p in old)


def merge_body(old, block):
    old = old or ''
    if BLOCK_START in old and BLOCK_END in old:
        head, _, rest = old.partition(BLOCK_START)
        _, _, tail = rest.partition(BLOCK_END)
        return head + block + tail
    return (old.rstrip() + '\n\n' if old.strip() else '') + block


def ancestor_link(branch, top, default):
    if branch == default:
        return f'`{branch}`'
    pr = open_pr(branch, top)
    name = display_name(branch, top)
    return f"#{pr['number']} **{name}**" if pr else f'**{name}** (`{branch}`, PR нет)'


def render_block(b, parent, top, number):
    default = default_branch(top)
    chain, cur, seen = [], parent, {b}
    while len(chain) < 10:
        chain.append(cur)
        if cur == default or cur in seen:
            break
        seen.add(cur)
        cur = parent_for(cur, top)
    path = ' ← '.join(ancestor_link(x, top, default) for x in reversed(chain))
    lines = [BLOCK_START, '---']
    if orphaned(b, top):
        lines += [f'> {ORPHAN_NOTE} Закройте этот PR или восстановите workspace из ветки `{b}` '
                  f'(`git restore-workspace {b}` в любом терминале проекта). PR переведён в черновик.', '']
    lines += ['**Иерархия (Orca)**', '',
              f'{path} ← **{display_name(b, top)}** ← вы здесь', '']
    if parent == default:
        lines.append(f'**Родитель:** `{default}` (корневая задача)')
    else:
        pp = open_pr(parent, top)
        lines.append(f"**Родитель:** {display_name(parent, top)} · ветка `{parent}` · "
                     + (f"PR #{pp['number']}" if pp else 'PR нет'))
    kids = format_children(gh_json('pr', 'list', '--base', b, '--state', 'all', '--json', PR_FIELDS, cwd=top))
    lines += ['', '**Дочерние PR (вливаются сюда):**' if kids else '**Дочерние PR:** нет', *kids]
    history = format_history(gh_json('pr', 'list', '--head', b, '--state', 'all', '--json', PR_FIELDS, cwd=top), number)
    if history:
        lines += ['', f'**Ранее по этой ветке:** {history}']
    base = f'origin/{parent}' if ref_exists(f'origin/{parent}', top) else parent
    subjects = [x for x in git('log', '--reverse', '--format=%s', f'{base}..origin/{b}', cwd=top, check=False).splitlines()
                if not x.startswith(PLACEHOLDER)]
    if subjects:
        lines += ['', '**Коммиты**', *[f'- {x}' for x in subjects[:30]]]
        if len(subjects) > 30:
            lines.append(f'- … и ещё {len(subjects) - 30}')
    lines += ['', '<sub>Блок обновляется автоматически при push; текст вне блока не меняется.</sub>', BLOCK_END]
    return '\n'.join(lines)


def refresh_pr(pr, b, parent, top):
    """Sync the title with the Orca worktree name (unless edited on GitHub) and the hierarchy block."""
    fields = {}
    title = display_name(b, top)
    key = f'branch.{b}.orcaPrTitle'
    last = git('config', '--get', key, cwd=top, check=False)
    if pr['title'] != title and (not last or pr['title'] == last):
        fields['title'] = title
    if not last or pr['title'] == last or fields:
        git('config', key, title, cwd=top)
    body = merge_body(pr.get('body'), render_block(b, parent, top, pr['number']))
    if body != (pr.get('body') or ''):
        fields['body'] = body
    if fields:
        api_patch_pr(pr['number'], top, **fields)


def reopen_previous(b, top):
    """Reopen this worktree's own closed (unmerged) PR, if it has one."""
    number = git('config', '--get', f'branch.{b}.orcaPr', cwd=top, check=False)
    if not number:
        number = str((orca_info(b, top) or {}).get('linkedPR') or '')
    if not number.isdigit():
        return None
    try:
        old = gh_json('pr', 'view', number, '--json', PR_FIELDS, cwd=top)
    except FlowError:
        return None
    if old['state'] != 'CLOSED' or old['headRefName'] != b:
        return None
    try:
        api_patch_pr(old['number'], top, state='open')
    except FlowError as e:
        say(f"could not reopen PR #{old['number']} ({e}); opening a new one")
        return None
    say(f"reopened PR #{old['number']}")
    return open_pr(b, top)


def ensure_pr(b, top, base=None, ready=False, retarget=False, placeholder=False):
    """Open, reopen or update the PR of branch b into its parent; link it in Orca."""
    parent = base or live_parent(b, top)
    if parent == b:
        raise FlowError('a branch cannot be its own parent')
    ensure_parent_on_github(parent, top)
    git('fetch', '--quiet', 'origin', cwd=top, check=False)
    pr = open_pr(b, top) or reopen_previous(b, top)
    if pr and pr['baseRefName'] != parent:
        say(f"PR #{pr['number']} targets {pr['baseRefName']}, parent is {parent}")
        if retarget:
            api_patch_pr(pr['number'], top, base=parent)
            say(f"PR #{pr['number']} retargeted to {parent}")
        else:
            say('rerun `git publish --retarget` to change the PR base')
            parent = pr['baseRefName']
    if not pr:
        if not has_changes(b, parent, top):
            if not placeholder:
                say(f'{b} has no changes beyond {parent} on GitHub: no PR')
                return None
            if git('rev-list', '--count', f'origin/{parent}..origin/{b}', cwd=top, check=False) in ('', '0'):
                placeholder_commit(b, top)
        note = ((orca_info(b, top) or {}).get('comment') or '').strip()
        cmd = ['gh', 'pr', 'create', '--base', parent, '--head', b, '--title', display_name(b, top),
               '--body', merge_body(note, BLOCK_START + BLOCK_END)]
        if not ready:
            cmd.append('--draft')
        if subprocess.run(cmd, cwd=top).returncode:
            raise FlowError('gh pr create failed')
        pr = open_pr(b, top)
        git('config', f'branch.{b}.orcaPrTitle', pr['title'], cwd=top)
    git('config', f'branch.{b}.orcaPr', str(pr['number']), cwd=top)
    refresh_pr(pr, b, parent, top)
    if ready and pr.get('isDraft'):
        subprocess.run(['gh', 'pr', 'ready', str(pr['number'])], cwd=top, check=True)
    wt = worktree_of(b, top)
    if wt and orca_cli() and orca_worktree(wt) and keeps_link(wt, b, pr['number'], top):
        orca_json('worktree', 'set', '--worktree', f'path:{wt}', '--pr', str(pr['number']))
    if parent != default_branch(top):
        parent_pr = open_pr(parent, top)
        if parent_pr:
            refresh_pr(parent_pr, parent, parent_for(parent, top), top)
    say(f"{b} -> {parent}: {pr['url']}")
    return pr


def keeps_link(wt, b, number, top):
    """Link our PR in Orca unless the workspace links someone else's open PR (a review task)."""
    linked = str((orca_worktree(wt) or {}).get('linkedPR') or '')
    if linked.isdigit() and int(linked) == number:
        return False  # already linked: re-linking makes the Orca app reload the PR card
    if not linked.isdigit():
        return True
    try:
        other = gh_json('pr', 'view', linked, '--json', 'state,headRefName', cwd=top)
    except FlowError:
        return True
    return other['headRefName'] == b or other['state'] != 'OPEN'


def has_changes(b, parent, top):
    """Does origin/b change files relative to its merge base with the parent?

    Commit counts are not enough: after a squash merge and a sync, a branch keeps
    commits that are not in the parent although its files are identical."""
    base = f'origin/{parent}' if ref_exists(f'origin/{parent}', top) else parent
    if not ref_exists(f'origin/{b}', top) or not ref_exists(base, top):
        return False
    return not git_ok('diff', '--quiet', f'{base}...origin/{b}', cwd=top)


def placeholder_commit(branch, top):
    """Add an empty commit so GitHub accepts a PR for a branch without own commits.

    The tree is unchanged, so moving a branch that is checked out elsewhere leaves that
    worktree's files and index as they are. Squash merges drop the commit."""
    local = ref_exists(f'refs/heads/{branch}', top)
    ref = f'refs/heads/{branch}' if local else f'refs/remotes/origin/{branch}'
    tip = git('rev-parse', ref, cwd=top)
    new = git('commit-tree', f'{tip}^{{tree}}', '-p', tip, '-m',
              f'{PLACEHOLDER} for {display_name(branch, top)}', cwd=top)
    if local:
        git('update-ref', f'refs/heads/{branch}', new, tip, cwd=top)
    if not push(top, 'origin', f'{new}:refs/heads/{branch}'):
        if local:
            git('update-ref', f'refs/heads/{branch}', tip, new, cwd=top)
        raise FlowError(f'could not push the placeholder commit of {branch}')
    git('fetch', '--quiet', 'origin', branch, cwd=top, check=False)
    if local:
        git('branch', f'--set-upstream-to=origin/{branch}', branch, cwd=top, check=False)
    say(f'{branch} had no own commits: added an empty commit to open its PR')


def ancestors(branch, top):
    """Parent, grandparent, ... up to (excluding) the default branch."""
    default, out, seen = default_branch(top), [], {branch}
    cur = live_parent(branch, top)
    while cur != default and cur not in seen and len(out) < 10:
        out.append(cur)
        seen.add(cur)
        cur = parent_for(cur, top)
    return out


def ensure_stack(b, top, base=None, empty=False, **kw):
    """PR of b plus, with branchflow.stackPrs, PRs of all its ancestors."""
    git('fetch', '--quiet', 'origin', cwd=top, check=False)
    if not empty and not open_pr(b, top) and not has_changes(b, base or live_parent(b, top), top):
        say(f'{b} has no changes beyond its parent on GitHub: no PR')
        return None
    chain = ancestors(b, top) if enabled('stackPrs', top) else []
    for a in reversed(chain):
        try:
            ensure_pr(a, worktree_of(a, top) or top, placeholder=True)
        except FlowError as e:
            say(f'warning: no PR for ancestor {a}: {e}')
    pr = ensure_pr(b, top, base=base, placeholder=empty, **kw)
    for a in chain:  # children lists changed while the stack was built
        apr = open_pr(a, top)
        if apr:
            refresh_pr(apr, a, parent_for(a, top), top)
    return pr


def worktree_of(branch, top):
    path = None
    for line in git('worktree', 'list', '--porcelain', cwd=top).splitlines():
        if line.startswith('worktree '):
            path = line[len('worktree '):]
        elif line == f'branch refs/heads/{branch}' and path:
            return path
    return None


def cmd_abandon(args):
    top = toplevel()
    b = args.branch or task_branch(top)
    if b == default_branch(top):
        raise FlowError(f'{b} is the default branch')
    wt = worktree_of(b, top)
    online = has_origin(top)
    if online:
        git('fetch', '--quiet', '--prune', 'origin', cwd=top, check=False)
    problems = []
    if wt and git('status', '--porcelain', cwd=wt):
        problems.append(f'{wt} has uncommitted changes')
    if online and ref_exists(f'origin/{b}', top):
        ahead = git('rev-list', '--count', f'origin/{b}..refs/heads/{b}', cwd=top, check=False)
        if ahead not in ('', '0'):
            problems.append(f'{ahead} commit(s) of {b} are not on GitHub')
    kids = gh_json('pr', 'list', '--base', b, '--state', 'open', '--json', PR_FIELDS, cwd=top) if online else []
    if kids:
        problems.append('open child PRs ' + ', '.join(f"#{k['number']}" for k in kids)
                        + ' (with --force they are retargeted to the parent)')
    for p in problems:
        say(f'warning: {p}')
    if problems and not args.force:
        raise FlowError('nothing done; rerun with --force to drop them')
    if not args.yes:
        if not sys.stdin.isatty():
            raise FlowError('confirm with --yes')
        if input(f'[branch-flow] abandon {b}: close PR, delete GitHub branch, remove worktree? [y/N] ').lower() != 'y':
            return 1
    parent = parent_for(b, top)
    for k in kids:
        api_patch_pr(k['number'], top, base=parent)
        say(f"PR #{k['number']} retargeted to {parent}")
    pr = open_pr(b, top) if online else None
    if pr:
        api_patch_pr(pr['number'], top, state='closed')
        say(f"closed PR #{pr['number']}")
    if online and remote_has(b, top):
        r = subprocess.run(['gh', 'api', '-X', 'DELETE', f'repos/{{owner}}/{{repo}}/git/refs/heads/{b}'],
                           cwd=top, text=True, capture_output=True)
        say(f'deleted GitHub branch {b}' if not r.returncode else f'warning: GitHub branch kept: {r.stderr.strip()}')
    if online:
        git('fetch', '--quiet', '--prune', 'origin', cwd=top, check=False)  # drop origin/<b> so the name is free again
    main_top = git('worktree', 'list', '--porcelain', cwd=top).splitlines()[0].removeprefix('worktree ')
    if wt and wt != main_top:
        if orca_cli() and orca_worktree(wt):
            orca_json('worktree', 'rm', '--worktree', f'path:{wt}', '--delete-branch', '--force')
        else:
            git('worktree', 'remove', '--force', wt, cwd=main_top)
        say(f'removed worktree {wt}')
    if ref_exists(f'refs/heads/{b}', main_top) and worktree_of(b, main_top) is None:
        git('branch', '-D', b, cwd=main_top)
        say(f'deleted local branch {b}')
    return 0


def find_workspace(sel, top):
    """Orca workspace path by display name, branch, folder name or path (same project)."""
    if sel in ('active', 'current', '.'):
        return toplevel()
    common = git('rev-parse', '--path-format=absolute', '--git-common-dir', cwd=top)
    hits = []
    for w in (orca_json('worktree', 'list', '--limit', '10000') or {}).get('worktrees') or []:
        b = (w.get('branch') or '').removeprefix('refs/heads/')
        if sel.lower() in ((w.get('displayName') or '').lower(), b.lower(), Path(w['path']).name.lower(), w['path'].lower()):
            try:
                if git('rev-parse', '--path-format=absolute', '--git-common-dir', cwd=w['path']) == common:
                    hits.append(w['path'])
            except (FlowError, OSError):
                pass
    if len(hits) != 1:
        raise FlowError(f'workspace {sel!r}: ' + ('not found' if not hits else f'ambiguous: {hits}'))
    return hits[0]


def create_workspace(top, name, parent_path=None, branch=None, extra=(), base=None):
    """Create an Orca workspace: a stacked child of parent_path (started from the parent's
    branch, or from base), or a top-level one (from base, else Orca's default base).

    Without branch, Orca names the branch as usual. Returns (path, branch, parent)."""
    me = orca_worktree(top) or {}
    if not me.get('repoId'):
        raise FlowError('run this inside a checkout of the project that Orca knows')
    parent = base or (current_branch(parent_path) if parent_path else None)
    if parent_path and not parent:
        raise FlowError(f'{parent_path} has no branch checked out (detached HEAD)')
    cmd = [orca_cli(), 'worktree', 'create', '--repo', f"id:{me['repoId']}", '--name', name, '--json', *extra]
    if branch:
        cmd += ['--branch', branch]
    if parent:
        local = ref_exists(f'refs/heads/{parent}', top)
        if not local and not ref_exists(f'refs/remotes/origin/{parent}', top):
            raise FlowError(f'base branch {parent} exists neither locally nor on GitHub')
        cmd += ['--base-branch', parent if local else f'origin/{parent}']
    cmd += ['--parent-worktree', f'path:{parent_path}'] if parent_path else ['--no-parent']
    out = json.loads(subprocess.run(cmd, text=True, capture_output=True, timeout=600).stdout or '{}')
    wt = ((out.get('result') or {}).get('worktree')) or {}
    path, b = wt.get('path'), (wt.get('branch') or '').removeprefix('refs/heads/')
    if not out.get('ok') or not path:
        raise FlowError(f'orca worktree create failed: {out.get("error") or out}')
    b = current_branch(path) or b
    if not b:
        raise FlowError(f'{path} was created without a branch')
    if parent and not based_on(b, parent, path):
        say(f'warning: {b} is not based on {parent}; check the workspace before committing')
    parent = parent or default_branch(top)
    record_parent(b, parent, top)
    record_workspace(b, path, top)
    say(f'created {name!r}: {path}, branch {b}, parent {parent}')
    return path, b, parent


def cmd_new(args):
    """Create an Orca workspace for a stacked child (or a top-level one) on request."""
    top = toplevel()
    extra = []
    for flag in ('agent', 'prompt', 'model', 'effort'):
        if getattr(args, flag):
            extra += [f'--{flag}', getattr(args, flag)]
    parent_path = None if args.top else find_workspace(args.parent or 'active', top)
    create_workspace(top, args.name, parent_path, args.branch, extra, args.base)
    say('nothing is pushed automatically: run `git publish` there to open its PR')
    return 0


# --- ship: move uncommitted work into a (new) child workspace -------------------------

def busy(top):
    gitdir = Path(git('rev-parse', '--absolute-git-dir', cwd=top))
    return any((gitdir / n).exists() for n in ('rebase-merge', 'rebase-apply', 'MERGE_HEAD',
                                                'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'))


def snapshot(top, paths=()):
    """Tree of HEAD plus the worktree's changes (staged, unstaged, untracked; not ignored)
    under paths. Uses a private index: the worktree's own index is not touched."""
    index = Path(git('rev-parse', '--absolute-git-dir', cwd=top)) / f'branch-flow-ship-{os.getpid()}.index'
    env = {**os.environ, 'GIT_INDEX_FILE': str(index)}

    def run(*a):
        r = subprocess.run(['git', *a], cwd=top, env=env, text=True, capture_output=True)
        if r.returncode:
            raise FlowError(f"git {' '.join(a)}: {r.stderr.strip()}")
        return r.stdout.strip()
    try:
        run('read-tree', 'HEAD')
        run('add', '-A', '--', *(paths or ['.']))
        return run('write-tree')
    finally:
        index.unlink(missing_ok=True)


def changed_files(top, tree):
    """[(status, path)] between HEAD and tree (no rename detection)."""
    out = git('diff', '--name-status', '--no-renames', '-z', 'HEAD', tree, cwd=top).split('\0')
    return [(out[i], out[i + 1]) for i in range(0, len(out) - 1, 2)]


def land(target, base, tree, message):
    """Commit the change base->tree on top of the (clean) target worktree, running the
    project's commit hooks."""
    if git('status', '--porcelain', cwd=target):
        raise FlowError(f'{target} has uncommitted changes; ship into a clean workspace')
    if busy(target):
        raise FlowError(f'{target} is in the middle of a merge/rebase')
    head = git('rev-parse', 'HEAD', cwd=target)
    if head == base:
        merged = tree
    else:  # an existing workspace that moved on: three-way merge without touching files
        change = git('commit-tree', tree, '-p', base, '-m', message, cwd=target)
        r = subprocess.run(['git', 'merge-tree', '--write-tree', '--name-only', '--merge-base', base, head, change],
                           cwd=target, text=True, capture_output=True)
        if r.returncode:
            conflicts = [x for x in r.stdout.split('\n\n')[0].splitlines()[1:] if x]
            raise FlowError(f'the changes conflict with {target}: ' + (', '.join(conflicts) or r.stderr.strip()))
        merged = r.stdout.splitlines()[0]
    git('read-tree', '-m', '-u', 'HEAD', merged, cwd=target)
    r = subprocess.run(['git', 'commit', '-q', '-m', message], cwd=target, text=True, capture_output=True)
    if r.returncode:
        git('reset', '-q', '--hard', 'HEAD', cwd=target, check=False)  # was clean; the source keeps the work
        raise FlowError(f'commit in {target} failed: {(r.stderr or r.stdout).strip()}')
    return git('rev-parse', 'HEAD', cwd=target)


def unship(top, tree, paths=()):
    """Remove the shipped changes from the source worktree, if it still matches the snapshot."""
    if snapshot(top, paths) != tree:
        say(f'warning: {top} changed during ship; its changes were left in place (remove the shipped ones by hand)')
        return False
    files = changed_files(top, tree)
    added = [p for s, p in files if s == 'A']
    others = [p for s, p in files if s != 'A']
    env = {**os.environ, 'GIT_LITERAL_PATHSPECS': '1'}
    for cmd, items in ((['rm', '-q', '--cached', '--ignore-unmatch'], added),
                       (['restore', '--source=HEAD', '--staged', '--worktree'], others)):
        if items:
            subprocess.run(['git', *cmd, '--pathspec-from-file=-', '--pathspec-file-nul'], cwd=top, env=env,
                           input='\0'.join(items), text=True, check=True, capture_output=True)
    for p in added:
        f = Path(top, p)
        if f.is_file() or f.is_symlink():
            f.unlink()
        d = f.parent
        while d != Path(top) and d.is_dir() and not any(d.iterdir()):
            d.rmdir()
            d = d.parent
    return True


def child_workspace(name, parent_path):
    """Existing Orca child of parent_path whose name or branch matches name."""
    pid = (orca_worktree(parent_path) or {}).get('id')
    slug = re.sub(r'[^a-z0-9._-]+', '-', name.lower()).strip('-.')
    if not pid:
        return None
    hits = []
    for w in (orca_json('worktree', 'list', '--limit', '10000') or {}).get('worktrees') or []:
        b = (w.get('branch') or '').removeprefix('refs/heads/').lower()
        if w.get('parentWorktreeId') == pid and name.lower() in ((w.get('displayName') or '').lower(), b) or \
                w.get('parentWorktreeId') == pid and b == slug:
            hits.append(w['path'])
    if len(hits) > 1:
        raise FlowError(f'workspace {name!r} under {parent_path} is ambiguous: {hits}')
    return hits[0] if hits else None


def cmd_ship(args):
    """Move the uncommitted changes of this workspace into a child workspace (created if
    missing; a chain A B C nests C under B under A), commit them there and publish."""
    src = toplevel()
    if busy(src):
        raise FlowError('finish the merge/rebase in progress first')
    paths = [str(Path(p).resolve()) for p in args.path]
    base = git('rev-parse', 'HEAD', cwd=src)
    tree = snapshot(src, paths)
    if tree == git('rev-parse', 'HEAD^{tree}', cwd=src):
        raise FlowError('no uncommitted changes to ship' + (' under the given paths' if paths else ''))
    files = changed_files(src, tree)
    message = args.message or args.names[-1]
    if len(args.branch) > len(args.names):
        raise FlowError('more --branch values than workspace names')
    branches = args.branch + [None] * (len(args.names) - len(args.branch))
    plan, parent = [], src
    for name, branch in zip(args.names, branches):
        found = child_workspace(name, parent) if parent else None
        plan.append((name, branch, found))
        parent = found
    say(f'from {src} ({current_branch(src)}): {len(files)} file(s)')
    for s, p in files:
        print(f'    {s} {p}')
    for depth, (name, branch, found) in enumerate(plan):
        print(f"    {'  ' * depth}└ {name}: " + (f'existing {found}' if found else
                                                 'new workspace' + (f', branch {branch}' if branch else '')))
    print(f'    commit: {message!r}' + ('' if args.keep else '; then removed from the source'))
    print('    then: ' + ('nothing pushed (--no-publish)' if args.no_publish else 'git publish (draft PR chain)'))
    if args.dry_run:
        return 0
    parent = src
    for name, branch, found in plan:
        if not found:
            found, _, _ = create_workspace(src, name, parent, branch)
        parent = found
    target = parent
    sha = land(target, base, tree, message)
    b = current_branch(target)
    say(f'committed {sha[:7]} on {b} in {target}')
    if not args.keep:
        if unship(src, tree, paths):
            say(f'removed the shipped changes from {src}')
    if args.no_publish or not has_origin(target):
        say('not published; run `git publish` there when ready')
        return 0
    r = subprocess.run([sys.executable, str(Path(__file__).resolve()), 'publish', *(['--ready'] if args.ready else [])],
                       cwd=target)
    if r.returncode:
        say(f'warning: publish failed; the commit is safe in {target}: run `git publish` there')
        return 1
    return 0


def cmd_restore(args):
    """Recreate a deleted Orca workspace on its existing branch (same PR, same name)."""
    top = toplevel()
    b = args.branch
    if has_origin(top):
        git('fetch', '--quiet', 'origin', cwd=top, check=False)
    source = b if ref_exists(f'refs/heads/{b}', top) else f'origin/{b}'
    if not ref_exists(source, top):
        raise FlowError(f'branch {b} exists neither locally nor on GitHub')
    if b in worktree_branches(top):
        raise FlowError(f'{b} already has a worktree: {worktree_of(b, top)}')
    if source == b and ref_exists(f'origin/{b}', top) and not git_ok('merge-base', '--is-ancestor', f'origin/{b}', b, cwd=top):
        source = f'origin/{b}' if git_ok('merge-base', '--is-ancestor', b, f'origin/{b}', cwd=top) else source
    parent = args.parent or parent_for(b, top)
    keep = {k: git('config', '--get', f'branch.{b}.{k}', cwd=top, check=False) for k in ('orcaPr', 'orcaPrTitle')}
    me = orca_worktree(top) or {}
    if not me.get('repoId'):
        raise FlowError('run this inside a checkout of the project that Orca knows')
    cmd = [orca_cli(), 'worktree', 'create', '--repo', f"id:{me['repoId']}", '--name', args.name or display_name(b, top),
           '--base-branch', source, '--branch', f'{b}-restore', '--json']
    pw = worktree_of(parent, top)
    cmd += ['--parent-worktree', f'path:{pw}'] if pw and is_workspace(pw) else ['--no-parent']
    out = json.loads(subprocess.run(cmd, text=True, capture_output=True, timeout=600).stdout or '{}')
    wt = ((out.get('result') or {}).get('worktree')) or {}
    path, tmp = wt.get('path'), (wt.get('branch') or '').removeprefix('refs/heads/')
    if not out.get('ok') or not path or not tmp:
        raise FlowError(f'orca worktree create failed: {out.get("error") or out}')
    if git('rev-parse', 'HEAD', cwd=path) != git('rev-parse', source, cwd=top):
        raise FlowError(f'{path} is not at {source}; left as is for inspection')
    if ref_exists(f'refs/heads/{b}', top):
        git('branch', '-D', b, cwd=top)  # its commits are all in the new checkout
    git('branch', '-m', tmp, b, cwd=path)
    git('config', '--remove-section', f'orcaworkspace.{tmp}', cwd=top, check=False)
    if ref_exists(f'origin/{b}', top):
        git('branch', '--set-upstream-to', f'origin/{b}', b, cwd=path)
    record_parent(b, parent, top)
    record_workspace(b, path, top)
    for k, v in keep.items():
        if v:
            git('config', f'branch.{b}.{k}', v, cwd=top)
    pr = open_pr(b, top) if has_origin(top) else None
    if pr:
        orca_json('worktree', 'set', '--worktree', f'path:{path}', '--pr', str(pr['number']))
        refresh_pr(pr, b, parent, top)
    say(f'restored {b} in {path}' + (f" (PR #{pr['number']}; mark it ready on GitHub when you want)" if pr else ''))
    return 0


def resolve_project(name):
    """Project root for a name (Orca project name, folder under ~/orca/projects, or path); default: cwd."""
    if not name:
        return git('rev-parse', '--path-format=absolute', '--git-common-dir', cwd=toplevel()).removesuffix('/.git')
    repos = (orca_json('repo', 'list') or {}).get('repos') or []
    for r in repos:
        if name.lower() in ((r.get('displayName') or '').lower(), Path(r.get('path', '')).name.lower()):
            return r['path']
    path = Path(name).expanduser()
    if path.is_dir():
        return git('rev-parse', '--path-format=absolute', '--git-common-dir', cwd=str(path)).removesuffix('/.git')
    known = ', '.join(r.get('displayName') or '' for r in repos)
    raise FlowError(f'unknown project {name!r}; known: {known}')


def pr_state(pr):
    if not pr:
        return 'PR нет'
    word = {'OPEN': 'черновик' if pr.get('isDraft') else 'открыт', 'MERGED': 'влит', 'CLOSED': 'закрыт'}[pr['state']]
    return f"PR #{pr['number']} {word} → {pr['baseRefName']}"


def cmd_status(args):
    """Read-only overview of one project: Orca workspace tree, branches, PRs, problems."""
    root = resolve_project(args.project)
    common = Path(git('rev-parse', '--path-format=absolute', '--git-common-dir', cwd=root))
    origin = has_origin(root)
    if origin and not args.no_fetch:
        git('fetch', '--quiet', 'origin', cwd=root, check=False)
    default = default_branch(root)
    wts = []
    for w in (orca_json('worktree', 'list', '--limit', '10000') or {}).get('worktrees') or []:
        try:
            same = Path(git('rev-parse', '--path-format=absolute', '--git-common-dir', cwd=w['path'])) == common
        except (FlowError, OSError):
            same = False
        if same:
            wts.append(w)
    prs = {}
    if origin:
        for pr in gh_json('pr', 'list', '--state', 'all', '--limit', '300', '--json',
                          'number,state,isDraft,baseRefName,headRefName', cwd=root):
            cur = prs.get(pr['headRefName'])
            if not cur or (pr['state'] == 'OPEN', pr['number']) > (cur['state'] == 'OPEN', cur['number']):
                prs[pr['headRefName']] = pr
    by_id = {w['id']: w for w in wts}
    kids = {}
    for w in wts:
        parent = w.get('parentWorktreeId') if w.get('parentWorktreeId') in by_id else None
        kids.setdefault(parent, []).append(w)
    print(f'{Path(root).name}  ({"GitHub" if origin else "без GitHub"}, основная ветка {default})')
    problems, branches = [], set()

    def show(w, depth):
        b = (w.get('branch') or '').removeprefix('refs/heads/')
        branches.add(b)
        name = Path(root).name if w.get('isMainWorktree') else (w.get('displayName') or Path(w['path']).name)
        bits = [f'`{b}`' if b else 'detached']
        if w.get('isMainWorktree'):
            bits.append('проект')
        elif origin and b:
            bits.append(pr_state(prs.get(b)))
        if origin and b and ref_exists(f'refs/remotes/origin/{b}', root):
            ahead, behind = git('rev-list', '--left-right', '--count', f'{b}...origin/{b}', cwd=root).split()
            if ahead != '0':
                bits.append(f'↑{ahead} не отправлено')
            if behind != '0':
                bits.append(f'↓{behind} отстаёт от GitHub')
        elif origin and b and b != default and not w.get('isMainWorktree'):
            bits.append('нет на GitHub')
        dirty = len(git('status', '--porcelain', cwd=w['path'], check=False).splitlines())
        if dirty:
            bits.append(f'{dirty} незакоммич.')
        if b and b != default and not w.get('isMainWorktree') and stacked(b, w['path']):
            bits.append(f"стек → {parent_of(b, w['path'], ask_orca=False)}")
        print(f"{'  ' * depth}{'└ ' if depth else ''}{name} · " + ' · '.join(bits))
        for k in sorted(kids.get(w['id'], []), key=lambda x: x.get('displayName') or ''):
            show(k, depth + 1)

    for w in sorted(kids.get(None, []), key=lambda x: (not x.get('isMainWorktree'), x.get('displayName') or '')):
        show(w, 0)
    records = workspace_records(root)
    for b, pr in sorted(prs.items()):
        if pr['state'] == 'OPEN' and b not in branches and b in records:
            problems.append(f"PR #{pr['number']} (`{b}`) открыт, а workspace нет: закрыть или git restore-workspace {b}")
    if problems:
        print('\nТребует внимания:')
        for x in problems:
            print(f'- {x}')
    return 0


MENU = """Stacked PRs — только по запросу (само ничего не пушится и PR не открываются)
  в pi:  /flow status [проект]  ·  /flow (это меню)   — модель не вызывается
  в терминале Orca (или в pi через !!):
  git flow-status [проект]   дерево workspace, ветки, PR (по умолчанию текущий проект)
  git flow-help              это меню
  git publish [--base B]     отправить ветку и открыть/обновить PR в родителя
                             и PR предков (--empty, --ready, --retarget)
  git parent [--set B]       родитель текущей ветки (куда смотрит её PR)
  git sync-parent [--no-push]  влить родителя в текущую ветку и отправить
  git new-workspace N [--parent W | --top] [--branch B] [--base B]
                             создать дочерний workspace от ветки родителя (для стека)
  git ship N [N2 ...] [-m msg] [-p путь] [-b ветка ...] [--no-publish] [--dry-run]
                             незакоммиченное -> дочерний workspace N (N2 внутри N),
                             коммит, push, PR; из текущего убирается
  git restore-workspace B    вернуть удалённый workspace ветки B
  git abandon                бросить задачу (закрыть PR, удалить ветки и worktree)
Ветки называете вы сами (или Orca по своим настройкам). pre-push запрещает
только force-push и удаление веток на GitHub.

С агентом: /skill:branch-flow <запрос>   (агент выполняет, ваш запрос = разрешение)
  status [проект]          то же дерево + пояснение проблем
  explain                  объяснить схему для workspace простыми словами
  publish <ws> [into <ветка>] [empty]
                           отправить ветку, открыть/обновить PR (into: задать родителя;
                           empty: без изменений)
  ready <ws>               снять с PR пометку черновика
  merge <ws> [to main]     squash-мерж в родителя; to main: по цепочке снизу вверх
  sync <ws>                влить родителя в ветку и отправить
  sync-main <ws>           провести свежий main по цепочке сверху вниз
  child of <ws>: <имя> [branch <ветка>]
                           создать дочерний workspace от ветки родителя
  top: <имя> [branch <ветка>]  создать корневой workspace (PR в main)
  ship <имя> [> <имя2>] [branch <ветка>]
                           выпустить текущие изменения в дочернем workspace (цепочкой)
  move <ws> under <ws2>    перенести под другого родителя
  rename <ws> to <имя>     переименовать workspace (заголовок PR следом)
  abandon <ws> [force]     закрыть PR, удалить ветки и worktree
  restore <ветка>          вернуть удалённый workspace на прежние ветку и PR
  remove merged            удалить workspace с влитыми PR (сначала список)
  orphans                  открытые PR без workspace: вернуть или закрыть
  cleanup [delete]         после мержей: синхронизация стека, пометки PR
                           (delete: ещё и удалить завершённые ветки на GitHub)
  doctor                   проверить pre-push, gh, остатки старой автоматики
  install <проект>         поставить pre-push в новый проект"""


def cmd_menu(args):
    print(MENU)
    return 0


def cmd_publish(args):
    top = toplevel()
    b = task_branch(top)
    if not has_origin(top):
        raise FlowError('no origin remote: nothing to publish')
    if b == default_branch(top):
        raise FlowError(f'{b} is the default branch; publish task branches only')
    if args.base:
        if args.base == b or not first_ref(args.base, top):
            raise FlowError(f'unknown base branch {args.base}')
        record_parent(b, args.base, top)
    elif not stacked(b, top):
        record_parent(b, parent_for(b, top), top)  # remember it, so the stack stays stable
    if is_workspace(top) and b not in workspace_records(top):
        record_workspace(b, top, top)
    ensure_parent_on_github(live_parent(b, top), top)
    if not push(top, '--set-upstream', 'origin', f'refs/heads/{b}:refs/heads/{b}'):
        raise FlowError('push failed')
    ensure_stack(b, top, empty=args.empty, ready=args.ready, retarget=args.retarget)
    return 0


# --- reconcile (on request) ---------------------------------------------------------

def enabled(name, top):
    return git('config', '--type=bool', '--get', f'branchflow.{name}', cwd=top, check=False) != 'false'


def common_dir(top):
    return Path(git('rev-parse', '--path-format=absolute', '--git-common-dir', cwd=top))


def locked(top, branch):
    import fcntl
    f = open(common_dir(top) / f"branch-flow-{branch.replace('/', '_')}.lock", 'w')
    fcntl.flock(f, fcntl.LOCK_EX)
    return f


def stamp(msg):
    say(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}")


def cmd_reconcile(args):
    """On request, after merges on GitHub: for stacked branches (recorded parent) of Orca
    worktrees, fast-forward clean worktrees, merge the parent back into merged branches and
    refresh their PRs. Other branches and PRs are not touched."""
    import fcntl
    STATE.mkdir(parents=True, exist_ok=True)
    lock = open(STATE / 'orca-branch-flow.lock', 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        raise FlowError('another reconcile is running')
    root = resolve_project(args.project) if args.project else None
    data = orca_json('worktree', 'list', '--limit', '10000') or {}
    repos = {}
    for wt in data.get('worktrees', []):
        path = wt.get('path')
        if not path or wt.get('isMainWorktree') or not Path(path).is_dir():
            continue
        try:
            common = common_dir(path)
        except FlowError:
            continue
        if root and common != common_dir(root):
            continue
        repos.setdefault(common, []).append(path)
    for common, paths in repos.items():
        top = paths[0]
        if not has_origin(top):
            continue
        git('fetch', '--quiet', '--prune', 'origin', cwd=top, check=False)
        branches = {p: current_branch(p) for p in paths}
        branches = {p: b for p, b in branches.items() if b and stacked(b, p)}
        depth = {p: len(chain_of(b, p)) for p, b in branches.items()}
        for path in sorted(branches, key=lambda p: depth[p]):  # parents sync before children
            b = branches[path]
            if b == default_branch(path) or not ref_exists(f'refs/remotes/origin/{b}', path):
                continue
            fast_forward(b, path)
            try:
                sync_after_merge(b, path)
            except (FlowError, subprocess.CalledProcessError) as e:
                stamp(f'reconcile {b}: sync after merge failed: {e}')
            try:
                with locked(path, 'pr-' + b):
                    pr = open_pr(b, path)
                    if pr and BLOCK_START in (pr.get('body') or ''):
                        refresh_pr(pr, b, live_parent(b, path), path)
            except (FlowError, subprocess.CalledProcessError) as e:
                stamp(f'reconcile {b}: {e}')
        try:
            flag_orphans(top)
        except (FlowError, subprocess.CalledProcessError) as e:
            stamp(f'reconcile orphans: {e}')
        if args.delete_branches:
            try:
                cleanup_remote(top)
            except (FlowError, subprocess.CalledProcessError) as e:
                stamp(f'reconcile cleanup: {e}')
    return 0


def chain_of(b, path):
    """Recorded ancestors (no network), for ordering."""
    default, out, cur = default_branch(path), [], b
    while len(out) < 10:
        cur = parent_for(cur, path)
        if cur in out or cur == b:
            break
        out.append(cur)
        if cur == default:
            break
    return out


def sync_after_merge(b, path):
    """After b's PR was (squash-)merged, merge the parent back so the next PR shows only new work."""
    if git('status', '--porcelain', '--untracked-files=no', cwd=path):
        return
    prs = gh_json('pr', 'list', '--head', b, '--state', 'all', '--json', PR_FIELDS, cwd=path)
    if not prs or any(p['state'] == 'OPEN' for p in prs):
        return
    if max(prs, key=lambda p: p['number'])['state'] != 'MERGED':
        return
    parent = live_parent(b, path)
    target = f'origin/{parent}' if ref_exists(f'origin/{parent}', path) else parent
    if not ref_exists(target, path) or git_ok('merge-base', '--is-ancestor', target, 'HEAD', cwd=path):
        return
    r = subprocess.run(['git', 'merge', '--no-edit', '-m', f'Sync {b} with {parent} after merge', target],
                       cwd=path, text=True, capture_output=True)
    if r.returncode:
        subprocess.run(['git', 'merge', '--abort'], cwd=path, capture_output=True)
        stamp(f'reconcile: {b} conflicts with {parent}; run `git sync-parent` there by hand')
        return
    stamp(f'reconcile: merged {parent} into {b} after its PR was merged')
    if not push(path, 'origin', f'refs/heads/{b}:refs/heads/{b}'):
        stamp(f'reconcile: push of {b} failed')


def stale_branches(remote, live, prs_by_head, open_bases, tips, default):
    """GitHub branches that are safe to delete.

    A branch qualifies when no worktree has it, its newest PR is merged or closed, the
    GitHub tip is exactly what that PR saw, and no open PR has it as head or base."""
    out = []
    for b in remote:
        if b == default or b in live or b in open_bases:
            continue
        prs = prs_by_head.get(b) or []
        if not prs or any(p['state'] == 'OPEN' for p in prs):
            continue
        last = max(prs, key=lambda p: p['number'])
        if last.get('headRefOid') == tips.get(b):
            out.append(b)
    return out


def cleanup_remote(top):
    default = default_branch(top)
    tips = {}
    for line in git('ls-remote', '--heads', 'origin', cwd=top).splitlines():
        sha, ref = line.split('\t')
        tips[ref.removeprefix('refs/heads/')] = sha
    # A local branch without a worktree does not keep its GitHub branch: deletion still needs a
    # finished PR at the same tip, so nothing unmerged/unreviewed is lost (Restore branch on GitHub).
    live = worktree_branches(top)
    prs = gh_json('pr', 'list', '--state', 'all', '--limit', '500', '--json',
                  'number,state,headRefName,baseRefName,headRefOid', cwd=top)
    by_head, open_bases = {}, set()
    for p in prs:
        by_head.setdefault(p['headRefName'], []).append(p)
        if p['state'] == 'OPEN':
            open_bases.add(p['baseRefName'])
    for b in stale_branches(tips, live, by_head, open_bases, tips, default):
        r = subprocess.run(['gh', 'api', '-X', 'DELETE', f'repos/{{owner}}/{{repo}}/git/refs/heads/{b}'],
                           cwd=top, text=True, capture_output=True)
        stamp(f'reconcile: deleted GitHub branch {b} (worktree gone, PR finished)' if not r.returncode
              else f'reconcile: could not delete {b}: {r.stderr.strip()}')
        if not r.returncode and not ref_exists(f'refs/heads/{b}', top):
            git('config', '--remove-section', f'orcaworkspace.{b}', cwd=top, check=False)


def flag_orphans(top):
    """Open PRs whose Orca workspace was deleted: draft + note, never closed automatically."""
    records, live = workspace_records(top), worktree_branches(top)
    gone = [b for b in records if b not in live]
    if not gone:
        return
    for pr in gh_json('pr', 'list', '--state', 'open', '--limit', '500', '--json', PR_FIELDS, cwd=top):
        b = pr['headRefName']
        body = pr.get('body') or ''
        if b not in gone or ORPHAN_NOTE in body or BLOCK_START not in body:
            continue
        refresh_pr(pr, b, parent_for(b, top), top)
        if not pr.get('isDraft'):
            subprocess.run(['gh', 'pr', 'ready', '--undo', str(pr['number'])], cwd=top, capture_output=True)
        stamp(f"reconcile: workspace of {b} was deleted; PR #{pr['number']} marked draft with a note")


def fast_forward(b, path):
    """Bring a clean worktree up to its GitHub branch (e.g. after a child PR was merged there)."""
    if git('status', '--porcelain', '--untracked-files=no', cwd=path):
        return
    if git_ok('merge-base', '--is-ancestor', f'origin/{b}', 'HEAD', cwd=path):
        return
    if git_ok('merge-base', '--is-ancestor', 'HEAD', f'origin/{b}', cwd=path):
        git('merge', '--ff-only', '--quiet', f'origin/{b}', cwd=path, check=False)
        stamp(f'reconcile: fast-forwarded {b} to GitHub')


def crontab_lines():
    r = subprocess.run(['crontab', '-l'], text=True, capture_output=True)
    return r.stdout.splitlines() if r.returncode == 0 else []


def cmd_uninstall_cron(args):
    """Remove the reconcile crontab line of older versions."""
    lines = crontab_lines()
    keep = [x for x in lines if MARKER not in x]
    if keep != lines:
        subprocess.run(['crontab', '-'], input='\n'.join(keep) + '\n' if keep else '', text=True, check=True)
        say('removed the reconcile crontab line')
    return 0


def cmd_sync_parent(args):
    top = toplevel()
    b = task_branch(top)
    if has_origin(top):
        git('fetch', '--quiet', '--prune', 'origin', cwd=top)
    parent = live_parent(b, top)
    merged = False
    for ref in (f'origin/{parent}', parent):
        if not ref_exists(ref, top) or git_ok('merge-base', '--is-ancestor', ref, 'HEAD', cwd=top):
            continue
        if subprocess.run(['git', 'merge', '--no-edit', ref], cwd=top).returncode:
            raise FlowError(f'merge of {ref} stopped; resolve and commit, then rerun')
        merged = True
    say(f'{b} is up to date with {parent}' if not merged else f'merged {parent} into {b}')
    if merged and not args.no_push and has_origin(top) and remote_has(b, top):
        if not push(top, 'origin', f'refs/heads/{b}:refs/heads/{b}'):
            raise FlowError(f'push of {b} failed; the merge is committed locally')
        say(f'pushed {b}')
    elif merged:
        say('not pushed (--no-push, or the branch is not on GitHub yet: use git publish)')
    return 0


def cmd_parent(args):
    top = toplevel()
    b = task_branch(top)
    if args.set:
        if not ref_exists(args.set, top) and not ref_exists(f'origin/{args.set}', top):
            raise FlowError(f'unknown branch {args.set}')
        record_parent(b, args.set, top)
    print(parent_of(b, top))
    return 0


def check_push(lines, cwd=None):
    """Return a list of refusals for git pre-push stdin lines: deleting a remote branch, or
    replacing commits on it (force-push). Branch names and new branches are not checked."""
    problems = []
    for line in lines:
        parts = line.split()
        if len(parts) != 4:
            continue
        local_ref, local_sha, remote_ref, remote_sha = parts
        if not remote_ref.startswith('refs/heads/'):
            continue
        name = remote_ref.removeprefix('refs/heads/')
        if local_sha == ZERO:
            problems.append(f'refusing to delete remote branch {name}')
            continue
        if remote_sha != ZERO:
            if not git_ok('cat-file', '-e', remote_sha + '^{commit}', cwd=cwd):
                problems.append(f'{name} changed on GitHub: fetch and merge first')
            elif not git_ok('merge-base', '--is-ancestor', remote_sha, local_sha, cwd=cwd):
                problems.append(f'refusing to force-push {name}')
    return problems


def cmd_pre_push(args):
    problems = check_push(sys.stdin.read().splitlines())
    for p in problems:
        print(f'[branch-flow] {p}', file=sys.stderr)
    if problems:
        print(f'[branch-flow] {RULES}', file=sys.stderr)
        print('[branch-flow] only the owner may override once with: git push --no-verify', file=sys.stderr)
        return 1
    return 0


def owned(path):
    try:
        return MARKER in path.read_text(errors='replace')
    except OSError:
        return False


def write_owned(path, text, mode=0o644):
    if path.exists() and not owned(path):
        say(f'skip {path}: exists and is not managed by {MARKER}')
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(mode)
    say(f'wrote {path}')
    return True


def cmd_install(args):
    DATA.mkdir(parents=True, exist_ok=True)
    shutil.copy2(Path(__file__).resolve(), DATA / 'branch_flow.py')
    say(f'installed {DATA / "branch_flow.py"}')
    for name, sub in COMMANDS.items():
        write_owned(BIN / name, f'#!/bin/sh\n# {MARKER}\nexec python3 "{DATA}/branch_flow.py" {sub} "$@"\n', 0o755)
    cmd_uninstall_cron(args)
    return 0


def cmd_uninstall(args):
    for name in COMMANDS:
        p = BIN / name
        if owned(p):
            p.unlink()
            say(f'removed {p}')
    cmd_uninstall_cron(args)
    if (DATA / 'branch_flow.py').exists():
        shutil.rmtree(DATA)
        say(f'removed {DATA}')
    return 0


def repo_paths(path):
    root = Path(git('rev-parse', '--show-toplevel', cwd=path))
    common = Path(git('rev-parse', '--path-format=absolute', '--git-common-dir', cwd=path))
    return root, common


def hooks_dir(root, common):
    return Path(git('config', '--get', 'core.hooksPath', cwd=root, check=False) or common / 'hooks')


def remove_legacy(root, common):
    """Remove the automation of older versions: the Orca setup hook (local orca.yaml, which
    .worktreeinclude copied into every worktree), the post-commit auto-push hook, the
    git-exclude lines and toggles. Only untracked files carrying the marker are deleted."""
    found = False
    for line in git('worktree', 'list', '--porcelain', cwd=root).splitlines():
        if not line.startswith('worktree '):
            continue
        wt = Path(line.removeprefix('worktree '))
        for name in LEGACY_FILES:
            f = wt / name
            if f.is_file() and owned(f) and not git_ok('ls-files', '--error-unmatch', name, cwd=wt):
                f.unlink()
                say(f'removed {f}')
                found = True
    exclude = common / 'info/exclude'
    if exclude.exists():
        drop = {f'# {MARKER}', *(f'/{n}' for n in LEGACY_FILES)}
        lines = exclude.read_text().splitlines()
        keep = [line for line in lines if line not in drop]
        if keep != lines:
            exclude.write_text('\n'.join(keep) + ('\n' if keep else ''))
    for hook in LEGACY_HOOKS:
        f = hooks_dir(root, common) / hook
        if owned(f):
            f.unlink()
            say(f'removed {f}')
            found = True
    if found:  # set by the old install-repo
        git('config', '--unset', 'push.autoSetupRemote', cwd=root, check=False)
    for key in LEGACY_CONFIG:
        git('config', '--unset-all', key, cwd=root, check=False)
    return found


def cmd_install_repo(args):
    root, common = repo_paths(args.path)
    remove_legacy(root, common)
    write_owned(hooks_dir(root, common) / 'pre-push', HOOK, 0o755)
    return 0


def cmd_uninstall_repo(args):
    root, common = repo_paths(args.path)
    remove_legacy(root, common)
    f = hooks_dir(root, common) / 'pre-push'
    if owned(f):
        f.unlink()
        say(f'removed {f}')
    return 0


def cmd_setup(args):
    return 0  # Orca setup hook of older versions; a leftover orca.yaml copy calls it


def cmd_post_commit(args):
    return 0  # auto-push hook of older versions, until install-repo removes it


def main(argv=None):
    p = argparse.ArgumentParser(prog='branch-flow', description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)
    pub = sub.add_parser('publish')
    pub.add_argument('--base', help='override the parent branch for this PR')
    pub.add_argument('--ready', action='store_true', help='open or mark the PR ready for review')
    pub.add_argument('--retarget', action='store_true', help='change an existing PR base to the parent')
    pub.add_argument('--empty', action='store_true',
                     help='open the PR even without changes (adds an empty placeholder commit)')
    sp = sub.add_parser('sync-parent')
    sp.add_argument('--no-push', action='store_true', help='merge only')
    st = sub.add_parser('status', help='read-only overview of one project')
    st.add_argument('project', nargs='?', help='Orca project name or path (default: current)')
    st.add_argument('--no-fetch', action='store_true')
    sub.add_parser('menu', help='list commands')
    nw = sub.add_parser('new', help='create an Orca workspace for a stacked child (from the parent branch)')
    nw.add_argument('name')
    g = nw.add_mutually_exclusive_group()
    g.add_argument('--parent', help='parent workspace (name, branch, folder or path; default: current)')
    g.add_argument('--top', action='store_true', help='top-level workspace (PR into the default branch)')
    nw.add_argument('--branch', help='branch name (default: Orca names it from the workspace name)')
    nw.add_argument('--base', help='start from this branch instead of the parent branch; it becomes the PR base')
    nw.add_argument('--agent'); nw.add_argument('--prompt'); nw.add_argument('--model'); nw.add_argument('--effort')
    sh = sub.add_parser('ship', help='move uncommitted changes into a child workspace, commit and publish')
    sh.add_argument('names', nargs='+', help='child workspace name; several = nested chain (Bugs "Bug 1")')
    sh.add_argument('-m', '--message', help='commit message (default: the last name)')
    sh.add_argument('-p', '--path', action='append', default=[], help='ship only these paths (repeatable)')
    sh.add_argument('-b', '--branch', action='append', default=[],
                    help='branch name of a new workspace, in the order of the names (repeatable)')
    sh.add_argument('--keep', action='store_true', help='leave the changes in this workspace too')
    sh.add_argument('--ready', action='store_true', help='open the PR ready for review')
    sh.add_argument('--no-publish', action='store_true', help='commit only; push and open PRs later')
    sh.add_argument('--dry-run', action='store_true', help='show the plan, change nothing')
    rs = sub.add_parser('restore', help='recreate a deleted Orca workspace on its existing branch')
    rs.add_argument('branch')
    rs.add_argument('--name', help='workspace name (default: from the branch / PR title)')
    rs.add_argument('--parent', help='parent branch (default: the recorded one)')
    ab = sub.add_parser('abandon')
    ab.add_argument('branch', nargs='?')
    ab.add_argument('--yes', action='store_true', help='do not ask for confirmation')
    ab.add_argument('--force', action='store_true', help='also drop uncommitted/unpushed work and retarget child PRs')
    par = sub.add_parser('parent')
    par.add_argument('--set')
    sub.add_parser('pre-push').add_argument('hook_args', nargs='*')
    rc = sub.add_parser('reconcile', help='after merges: sync stacked branches, refresh their PRs')
    rc.add_argument('project', nargs='?', help='only this project (default: all)')
    rc.add_argument('--delete-branches', action='store_true',
                    help='also delete GitHub branches whose worktree is gone and PR finished')
    sub.add_parser('uninstall-cron', help='remove the crontab line of older versions')
    sub.add_parser('setup')  # legacy no-op
    sub.add_parser('post-commit')  # legacy no-op
    sub.add_parser('install')
    sub.add_parser('uninstall')
    for name in ('install-repo', 'uninstall-repo'):
        sub.add_parser(name).add_argument('path')
    args = p.parse_args(argv)
    handler = globals()['cmd_' + args.cmd.replace('-', '_')]
    try:
        return handler(args)
    except FlowError as e:
        print(f'[branch-flow] error: {e}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
