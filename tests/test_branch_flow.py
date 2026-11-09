import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[1] / 'tools/branch-flow/branch_flow.py'
spec = importlib.util.spec_from_file_location('branch_flow', PATH)
bf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bf)
ENV = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't',
       'GIT_COMMITTER_EMAIL': 't@t', 'GIT_CONFIG_GLOBAL': '/dev/null'}


def run(*args, cwd):
    return subprocess.run(['git', *args], cwd=cwd, env=ENV, check=True, text=True,
                          capture_output=True).stdout.strip()


class BranchFlowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        run('init', '-q', '-b', 'main', cwd=self.repo)
        run('commit', '-q', '--allow-empty', '-m', 'base', cwd=self.repo)
        run('switch', '-q', '-c', 'parent', cwd=self.repo)
        run('config', 'branch.parent.orcaParent', 'main', cwd=self.repo)
        run('commit', '-q', '--allow-empty', '-m', 'parent work', cwd=self.repo)
        run('switch', '-q', 'main', cwd=self.repo)
        env = patch.dict(os.environ, ENV)
        env.start()
        self.addCleanup(env.stop)

    def child(self, base='main'):
        path = self.root / 'child'
        run('worktree', 'add', '-q', '-b', 'child', str(path), base, cwd=self.repo)
        return path

    def test_pre_push_guards_only_force_and_delete(self):
        main = run('rev-parse', 'main', cwd=self.repo)
        parent = run('rev-parse', 'parent', cwd=self.repo)
        self.assertEqual(bf.check_push([f'refs/heads/parent {parent} refs/heads/parent {main}'], cwd=self.repo), [])
        # any name: new branches, other remote names, "/" in names, unrecorded branches
        for line in (f'refs/heads/parent {parent} refs/heads/parent {bf.ZERO}',
                     f'refs/heads/parent {parent} refs/heads/other {bf.ZERO}',
                     f'refs/heads/x {parent} refs/heads/user/some/task {bf.ZERO}',
                     f'HEAD {parent} refs/heads/anything {bf.ZERO}'):
            self.assertEqual(bf.check_push([line], cwd=self.repo), [], line)
        forced = bf.check_push([f'refs/heads/main {main} refs/heads/main {parent}'], cwd=self.repo)
        self.assertIn('force-push', forced[0])
        deleted = bf.check_push([f'(delete) {bf.ZERO} refs/heads/parent {parent}'], cwd=self.repo)
        self.assertIn('delete', deleted[0])
        unknown = bf.check_push([f'refs/heads/main {main} refs/heads/main {"f" * 40}'], cwd=self.repo)
        self.assertIn('fetch', unknown[0])
        self.assertEqual(bf.check_push([f'refs/tags/v1 {main} refs/tags/v1 {bf.ZERO}'], cwd=self.repo), [])

    def test_pre_push_hook_starts_nothing(self):
        main = run('rev-parse', 'main', cwd=self.repo)
        with patch('sys.stdin', io.StringIO(f'refs/heads/main {main} refs/heads/main {bf.ZERO}\n')), \
                patch.object(subprocess, 'Popen') as popen:
            self.assertEqual(bf.main(['pre-push', 'origin', 'url']), 0)
        popen.assert_not_called()

    def test_legacy_commands_are_noops(self):
        path = self.child()
        head = run('rev-parse', 'HEAD', cwd=path)
        old = os.getcwd()
        os.chdir(path)
        try:
            with patch.object(subprocess, 'Popen') as popen:
                self.assertEqual(bf.main(['setup']), 0)
                self.assertEqual(bf.main(['post-commit']), 0)
        finally:
            os.chdir(old)
        popen.assert_not_called()
        self.assertEqual(run('branch', '--show-current', cwd=path), 'child')
        self.assertEqual(run('rev-parse', 'HEAD', cwd=path), head)

    def test_parent_follows_orca_only_when_based_on_it(self):
        top = str(self.repo)
        run('branch', 'from-main', 'main', cwd=self.repo)
        run('branch', 'from-parent', 'parent', cwd=self.repo)
        with patch.object(bf, 'orca_parent_branch', return_value='parent'):
            # created from main under an Orca parent: its PR goes to main
            self.assertEqual(bf.parent_of('from-main', top), 'main')
            self.assertEqual(bf.parent_of('from-parent', top), 'parent')
            # the parent moved on after the child started: still based on it
            run('switch', '-q', 'parent', cwd=self.repo)
            run('commit', '-q', '--allow-empty', '-m', 'parent moves', cwd=self.repo)
            run('switch', '-q', 'main', cwd=self.repo)
            self.assertEqual(bf.parent_of('from-parent', top), 'parent')
            run('config', 'branch.from-main.orcaParent', 'parent', cwd=self.repo)
            self.assertEqual(bf.parent_of('from-main', top), 'parent')  # recorded wins
        with patch.object(bf, 'orca_parent_branch', return_value=None):
            self.assertEqual(bf.parent_of('from-parent', top), 'main')
        self.assertTrue(bf.stacked('from-main', top))
        self.assertFalse(bf.stacked('from-parent', top))

    def test_pr_text_helpers(self):
        self.assertEqual(bf.humanize('images-render'), 'Images render')
        self.assertEqual(bf.humanize('user/small_fixes'), 'Small fixes')
        block = f'{bf.BLOCK_START}\nnew\n{bf.BLOCK_END}'
        self.assertEqual(bf.merge_body('', block), block)
        self.assertEqual(bf.merge_body('mine', block), 'mine\n\n' + block)
        old = f'mine\n{bf.BLOCK_START}\nold\n{bf.BLOCK_END}\ntail'
        self.assertEqual(bf.merge_body(old, block), f'mine\n{block}\ntail')
        prs = [{'number': 7, 'title': 'B', 'state': 'MERGED'}, {'number': 5, 'title': 'A', 'state': 'OPEN', 'isDraft': True},
               {'number': 6, 'title': 'C', 'state': 'CLOSED'}]
        self.assertEqual(bf.format_children(prs), ['- [ ] #5 A · draft', '- [x] #7 B · влит'])
        self.assertEqual(bf.format_history(prs, 7), '#5 (draft), #6 (закрыт)')

    def test_placeholder_commit_keeps_checked_out_worktree_clean(self):
        origin = self.root / 'origin.git'
        subprocess.run(['git', 'init', '-q', '--bare', str(origin)], check=True)
        run('remote', 'add', 'origin', str(origin), cwd=self.repo)
        run('push', '-q', 'origin', 'main', 'parent', cwd=self.repo)
        path = self.child('parent')
        (path / 'wip.txt').write_text('staged')
        run('add', 'wip.txt', cwd=path)
        before = run('rev-parse', 'child', cwd=self.repo)
        with patch.object(bf, 'orca_cli', return_value=None), redirect_stdout(io.StringIO()):
            bf.placeholder_commit('child', self.repo)
        after = run('rev-parse', 'child', cwd=self.repo)
        self.assertEqual(run('rev-parse', 'child^', cwd=self.repo), before)
        self.assertEqual(run('rev-parse', 'child^{tree}', cwd=self.repo), run('rev-parse', before + '^{tree}', cwd=self.repo))
        self.assertTrue(run('log', '-1', '--format=%s', 'child', cwd=self.repo).startswith(bf.PLACEHOLDER))
        self.assertEqual(run('ls-remote', '--heads', 'origin', 'child', cwd=self.repo).split()[0], after)
        self.assertEqual(run('status', '--porcelain', cwd=path), 'A  wip.txt')

    def test_ancestors_follow_recorded_parents(self):
        for b, p in (('a', 'main'), ('b', 'a'), ('c', 'b')):
            run('branch', b, 'main', cwd=self.repo)
            run('config', f'branch.{b}.orcaParent', p, cwd=self.repo)
        with patch.object(bf, 'orca_cli', return_value=None), patch.object(bf, 'has_origin', return_value=False):
            self.assertEqual(bf.ancestors('c', str(self.repo)), ['b', 'a'])

    def test_orphaned_workspace_branch(self):
        path = self.child()
        top = str(self.repo)
        bf.record_workspace('child', path, top)
        self.assertFalse(bf.orphaned('child', top))
        run('worktree', 'remove', str(path), cwd=self.repo)
        self.assertTrue(bf.orphaned('child', top))
        run('branch', '-D', 'child', cwd=self.repo)  # the record survives branch deletion
        self.assertTrue(bf.orphaned('child', top))
        self.assertFalse(bf.orphaned('parent', top))  # never an Orca workspace

    def test_stale_branches(self):
        prs = {'done': [{'number': 1, 'state': 'MERGED', 'headRefOid': 'a'}],
               'moved': [{'number': 2, 'state': 'MERGED', 'headRefOid': 'old'}],
               'open': [{'number': 3, 'state': 'OPEN', 'headRefOid': 'c'}],
               'parent': [{'number': 4, 'state': 'MERGED', 'headRefOid': 'd'}],
               'kept': [{'number': 5, 'state': 'CLOSED', 'headRefOid': 'e'}]}
        tips = {'main': 'm', 'done': 'a', 'moved': 'new', 'open': 'c', 'parent': 'd', 'kept': 'e', 'nopr': 'f'}
        stale = bf.stale_branches(tips, {'kept'}, prs, {'parent'}, tips, 'main')
        self.assertEqual(stale, ['done'])

    def test_has_changes_ignores_synced_squash_history(self):
        origin = self.root / 'origin.git'
        subprocess.run(['git', 'init', '-q', '--bare', str(origin)], check=True)
        run('remote', 'add', 'origin', str(origin), cwd=self.repo)
        path = self.child('parent')
        (path / 'f.txt').write_text('x')
        run('add', 'f.txt', cwd=path)
        run('commit', '-q', '-m', 'work', cwd=path)
        run('push', '-q', 'origin', 'parent', 'child', cwd=self.repo)
        run('fetch', '-q', 'origin', cwd=self.repo)
        self.assertTrue(bf.has_changes('child', 'parent', str(self.repo)))
        # squash-merge child into parent, then sync parent back into child
        run('switch', '-q', 'parent', cwd=self.repo)
        run('merge', '-q', '--squash', 'child', cwd=self.repo)
        run('commit', '-q', '-m', 'squash', cwd=self.repo)
        run('merge', '-q', '--no-edit', 'parent', cwd=path)
        run('push', '-q', 'origin', 'parent', 'child', cwd=self.repo)
        run('fetch', '-q', 'origin', cwd=self.repo)
        self.assertNotEqual(run('rev-list', '--count', 'origin/parent..origin/child', cwd=self.repo), '0')
        self.assertFalse(bf.has_changes('child', 'parent', str(self.repo)))

    def fake_orca_create(self, calls):
        real = subprocess.run

        def fake(cmd, *a, **kw):
            if cmd[0] != 'orca':
                return real(cmd, *a, **kw)
            calls.append(cmd)
            branch = cmd[cmd.index('--branch') + 1] if '--branch' in cmd else 'orca-named'
            base = cmd[cmd.index('--base-branch') + 1] if '--base-branch' in cmd else 'main'
            path = self.root / branch.replace('/', '_')
            run('worktree', 'add', '-q', '-b', branch, str(path), base, cwd=self.repo)
            out = {'ok': True, 'result': {'worktree': {'path': str(path), 'branch': f'refs/heads/{branch}'}}}
            return subprocess.CompletedProcess(cmd, 0, json.dumps(out), '')
        return fake

    def test_create_workspace_lets_orca_name_and_bases_child_on_parent(self):
        calls = []
        parent_wt = self.root / 'parent-wt'
        run('worktree', 'add', '-q', str(parent_wt), 'parent', cwd=self.repo)
        with patch.object(bf, 'orca_worktree', return_value={'repoId': 'r'}), \
                patch.object(bf, 'orca_cli', return_value='orca'), \
                patch.object(subprocess, 'run', side_effect=self.fake_orca_create(calls)), \
                redirect_stdout(io.StringIO()):
            path, b, parent = bf.create_workspace(str(self.repo), 'Images v2', str(parent_wt))
            self.assertNotIn('--branch', calls[-1])  # Orca names it
            self.assertNotIn('--setup', calls[-1])  # the project's own setup policy
            self.assertEqual(calls[-1][calls[-1].index('--base-branch') + 1], 'parent')
            self.assertEqual((b, parent), ('orca-named', 'parent'))
            self.assertEqual(run('rev-parse', 'HEAD', cwd=path), run('rev-parse', 'parent', cwd=self.repo))
            self.assertEqual(run('config', 'branch.orca-named.orcaParent', cwd=self.repo), 'parent')
            _, b, parent = bf.create_workspace(str(self.repo), 'Top', None, 'me/top')
            self.assertIn('--no-parent', calls[-1])
            self.assertNotIn('--base-branch', calls[-1])
            self.assertEqual((b, parent), ('me/top', 'main'))

    def test_install_repo_adds_only_the_guard_and_is_reversible(self):
        hooks = self.repo / '.git/hooks'
        foreign = hooks / 'post-merge'
        foreign.write_text('#!/bin/sh\nexit 0\n')
        with redirect_stdout(io.StringIO()):
            bf.main(['install-repo', str(self.repo)])
        self.assertIn(bf.MARKER, (hooks / 'pre-push').read_text())
        self.assertFalse((hooks / 'post-commit').exists())
        self.assertFalse((self.repo / 'orca.yaml').exists())
        self.assertEqual(run('status', '--porcelain', cwd=self.repo), '')
        with redirect_stdout(io.StringIO()):
            bf.main(['uninstall-repo', str(self.repo)])
        self.assertFalse((hooks / 'pre-push').exists())
        self.assertTrue(foreign.exists())

    def test_install_repo_keeps_a_foreign_pre_push(self):
        hook = self.repo / '.git/hooks/pre-push'
        hook.write_text('#!/bin/sh\nexit 0\n')
        with redirect_stdout(io.StringIO()):
            bf.main(['install-repo', str(self.repo)])
            bf.main(['uninstall-repo', str(self.repo)])
        self.assertEqual(hook.read_text(), '#!/bin/sh\nexit 0\n')

    def test_install_repo_removes_old_automation(self):
        path = self.child()
        legacy_yaml = f'# {bf.MARKER}: local, untracked\nscripts:\n  setup: x\n'
        for top in (self.repo, path):
            (top / 'orca.yaml').write_text(legacy_yaml)
        (self.repo / '.worktreeinclude').write_text(f'# {bf.MARKER}\norca.yaml\n')
        (self.repo / '.git/info/exclude').write_text(f'# mine\n*.tmp\n# {bf.MARKER}\n/orca.yaml\n# {bf.MARKER}\n/.worktreeinclude\n')
        (self.repo / '.git/hooks/post-commit').write_text(f'#!/bin/sh\n# {bf.MARKER}\n')
        run('config', 'push.autoSetupRemote', 'true', cwd=self.repo)
        run('config', 'branchflow.autoPush', 'false', cwd=self.repo)
        tracked = self.root / 'tracked'
        run('worktree', 'add', '-q', '-b', 'tracked', str(tracked), 'main', cwd=self.repo)
        (tracked / 'orca.yaml').write_text(legacy_yaml)
        run('add', '-f', 'orca.yaml', cwd=tracked)
        run('commit', '-q', '-m', 'project orca.yaml', cwd=tracked)
        with redirect_stdout(io.StringIO()):
            bf.main(['install-repo', str(self.repo)])
        self.assertFalse((self.repo / 'orca.yaml').exists())
        self.assertFalse((path / 'orca.yaml').exists())  # copies in worktrees too
        self.assertTrue((tracked / 'orca.yaml').exists())  # tracked by the project: kept
        self.assertFalse((self.repo / '.worktreeinclude').exists())
        self.assertFalse((self.repo / '.git/hooks/post-commit').exists())
        self.assertEqual((self.repo / '.git/info/exclude').read_text(), '# mine\n*.tmp\n')
        self.assertEqual(subprocess.run(['git', 'config', 'push.autoSetupRemote'], cwd=self.repo).returncode, 1)
        self.assertEqual(subprocess.run(['git', 'config', 'branchflow.autoPush'], cwd=self.repo).returncode, 1)
        self.assertIn(bf.MARKER, (self.repo / '.git/hooks/pre-push').read_text())

    def ship_source(self):
        (self.repo / 'keep.txt').write_text('base\n')
        (self.repo / 'gone.txt').write_text('old\n')
        run('add', '.', cwd=self.repo)
        run('commit', '-q', '-m', 'files', cwd=self.repo)
        (self.repo / 'keep.txt').write_text('changed\n')
        (self.repo / 'gone.txt').unlink()
        (self.repo / 'new dir').mkdir()
        (self.repo / 'new dir' / 'n*w.txt').write_text('new\n')
        run('add', 'keep.txt', cwd=self.repo)  # staged and unstaged changes are both shipped
        (self.repo / '.gitignore').write_text('')
        return run('rev-parse', 'HEAD', cwd=self.repo)

    def test_ship_moves_changes_into_child_and_cleans_source(self):
        base = self.ship_source()
        index_before = run('diff', '--cached', '--name-only', cwd=self.repo)
        tree = bf.snapshot(str(self.repo))
        self.assertEqual(run('diff', '--cached', '--name-only', cwd=self.repo), index_before)  # own index untouched
        target = self.root / 'ship'
        run('worktree', 'add', '-q', '-b', 'ship', str(target), base, cwd=self.repo)
        sha = bf.land(str(target), base, tree, 'fix: thing')
        self.assertEqual(run('log', '-1', '--format=%s', cwd=target), 'fix: thing')
        self.assertEqual(run('rev-parse', f'{sha}^', cwd=target), base)
        self.assertEqual((target / 'keep.txt').read_text(), 'changed\n')
        self.assertFalse((target / 'gone.txt').exists())
        self.assertEqual((target / 'new dir' / 'n*w.txt').read_text(), 'new\n')
        self.assertEqual(run('status', '--porcelain', cwd=target), '')
        self.assertTrue(bf.unship(str(self.repo), tree))
        self.assertEqual(run('status', '--porcelain', cwd=self.repo), '')
        self.assertFalse((self.repo / 'new dir').exists())

    def test_ship_only_given_paths(self):
        self.ship_source()
        paths = [str(self.repo / 'keep.txt')]
        tree = bf.snapshot(str(self.repo), paths)
        self.assertEqual(bf.changed_files(str(self.repo), tree), [('M', 'keep.txt')])
        self.assertTrue(bf.unship(str(self.repo), tree, paths))
        left = [x.strip() for x in run('status', '--porcelain', cwd=self.repo).splitlines()]
        self.assertNotIn('M  keep.txt', left)
        self.assertIn('D gone.txt', left)
        self.assertIn('?? "new dir/"', left)

    def test_ship_into_moved_workspace_merges_or_refuses(self):
        base = self.ship_source()
        tree = bf.snapshot(str(self.repo))
        target = self.root / 'ship'
        run('worktree', 'add', '-q', '-b', 'ship', str(target), base, cwd=self.repo)
        (target / 'other.txt').write_text('x\n')
        run('add', '.', cwd=target)
        run('commit', '-q', '-m', 'other', cwd=target)
        bf.land(str(target), base, tree, 'merged in')
        self.assertTrue((target / 'other.txt').exists())
        self.assertEqual((target / 'keep.txt').read_text(), 'changed\n')
        clash = self.root / 'clash'
        run('worktree', 'add', '-q', '-b', 'clash', str(clash), base, cwd=self.repo)
        (clash / 'keep.txt').write_text('different\n')
        run('commit', '-q', '-am', 'clash', cwd=clash)
        head = run('rev-parse', 'HEAD', cwd=clash)
        with self.assertRaises(bf.FlowError) as e:
            bf.land(str(clash), base, tree, 'x')
        self.assertIn('keep.txt', str(e.exception))
        self.assertEqual(run('rev-parse', 'HEAD', cwd=clash), head)
        self.assertEqual(run('status', '--porcelain', cwd=clash), '')

    def test_ship_chain_creates_nested_children(self):
        self.ship_source()
        made = []

        def create(top, name, parent_path, branch=None, extra=(), base=None):
            b = branch or name.lower().replace(' ', '-')
            path = self.root / b
            run('worktree', 'add', '-q', '-b', b, str(path), current_branch(parent_path), cwd=self.repo)
            run('config', f'branch.{b}.orcaParent', current_branch(parent_path), cwd=self.repo)
            made.append((b, current_branch(parent_path)))
            return str(path), b, current_branch(parent_path)

        def current_branch(path):
            return run('branch', '--show-current', cwd=path)

        old = os.getcwd()
        os.chdir(self.repo)
        try:
            with patch.object(bf, 'create_workspace', side_effect=create), \
                    patch.object(bf, 'child_workspace', return_value=None), redirect_stdout(io.StringIO()):
                self.assertEqual(bf.main(['ship', 'Bugs', 'Bug 1', '-b', 'user/bugs', '-m', 'fix: bug 1',
                                          '--no-publish']), 0)
        finally:
            os.chdir(old)
        self.assertEqual(made, [('user/bugs', 'main'), ('bug-1', 'user/bugs')])
        self.assertEqual(run('log', '-1', '--format=%s', 'bug-1', cwd=self.repo), 'fix: bug 1')
        self.assertEqual(run('rev-parse', 'user/bugs', cwd=self.repo), run('rev-parse', 'main', cwd=self.repo))
        self.assertEqual(run('status', '--porcelain', cwd=self.repo), '')

    def test_unship_leaves_source_changed_meanwhile(self):
        self.ship_source()
        tree = bf.snapshot(str(self.repo))
        (self.repo / 'keep.txt').write_text('edited again\n')
        with redirect_stdout(io.StringIO()):
            self.assertFalse(bf.unship(str(self.repo), tree))
        self.assertEqual((self.repo / 'keep.txt').read_text(), 'edited again\n')


if __name__ == '__main__':
    unittest.main()
