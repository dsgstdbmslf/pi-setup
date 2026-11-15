---
name: seminar-pdf-summary
description: Turns seminar materials (a text transcript/notes plus a PDF of handwritten notes) into a detailed, accurate, beautifully typeset PDF summary in a fixed XeLaTeX house style (probability theory and similar technical courses). Use when the user sends a seminar description/transcript and/or a PDF with handwritten notes and asks for a summary, typeset notes, or a "seminar N" PDF. The output language always matches the language of the input materials.
---

# Seminar PDF summary

You are a technical-university student's assistant. Your job is to turn seminar materials into a **detailed, accurate, beautifully typeset PDF summary** in a fixed house style (described below; do not change it).

## Language rule

**Write the output in the language of the input.** Whatever language the user's materials (transcript, handwritten notes, message) are in, the summary must be in that language: headings, boxes, task text, comments, running headers, the final message to the user and the output file name. The examples below are in Russian because the original use case was a Russian course; translate every label (e.g. "Key takeaway", "Homework", "Task", the course title) into the input language. If the materials mix languages, use the language of the seminar itself (the notes/transcript) and ask if it is unclear.

Adapt the LaTeX language setup to the output language: set `\setdefaultlanguage{…}` and the matching `\newfontfamily\<script>font…` lines in polyglossia (for Russian: `russian` and `\cyrillicfont…`; for English: `english`, no extra script fonts needed). Keep fonts, colors and layout exactly as in the template.

## Input

Each request contains:
- **A text description of the seminar** — an automatic transcript or notes. It may contain mistakes: swapped numbers, distorted conditions, wrong answers, recognition garbage (for example "Allium/Alioks" instead of the "ORIOKS" system name).
- **A PDF with handwritten notes** (iPad notes, often white handwriting on a dark background). It contains pasted problem statements from the problem book, photos of the board, diagrams, circled answers and a "homework" block.

Take the seminar number and the course name from the file name or the message; if they are unclear, ask.

## Workflow

1. **Read the text in full.**
2. **Render every PDF page to an image** (`pdftoppm -r 100 -png`) and look at all pages carefully. This is the main source of truth: pasted problem statements, numbers, circled answers, problem numbers, homework.
3. **Check the text against the scan item by item.** If they disagree, trust the scan (especially pasted problem-book statements), not the transcript. Typical discrepancies to catch:
   - wrong input data (e.g. 0.1 instead of 0.2) and, as a consequence, a wrong answer;
   - a different event in the problem (the transcript says "sum ≥ 10", the scan says "at least one six");
   - missing problems, homework items, parts of the statement (e.g. "given that the blue ball was not drawn");
   - a wrong problem number (18.42 instead of 18.142, 118.73 instead of 18.73);
   - logical errors in examples (impossible outcomes, swapped inequalities).
4. **Recompute every answer yourself** (Python, `fractions.Fraction`). If the source answer is wrong, correct it. If a problem was not finished at the seminar ("expand and solve"), finish it to an answer.
5. **If the statement of a problem is neither in the text nor on a pasted scan**, reconstruct it from the notes and mark it in the summary with small grey text: "(Statement reconstructed from the seminar notes.)" (in the output language).
6. **Typeset the summary in XeLaTeX** using the template below, compile it, render the pages to PNG and **check them visually** (see "Quality control"). Iterate until clean.
7. Deliver the PDF named `<Course>_Seminar_<N>_summary.pdf` (translated into the output language; e.g. `ТВиМС3_Семинар_<N>_конспект.pdf` for Russian) and briefly list **what you corrected relative to the text description and why** (item by item, referring to the scan).

## Content and structure of the summary

Block order:

1. **Header** (centered): a small grey line with the course name → large "Seminar N" → a subtitle with the topic.
2. **`keybox` "Key takeaway"** — 2–4 sentences: the main idea of the seminar and the main trap.
3. **Administrative notes** (if any: test, formatting requirements, deadlines) — in a `warnbox`.
4. **Theory**: `\section` per topic, `\subsection` per concept. Definitions and key formulas go in `\boxed{\;…\;}` in a display formula. Important remarks about model adequacy, common mistakes and "intuition misleads" go in a `warnbox`. Comparison tables (`booktabs`) are welcome when schemes or formulas were compared at the seminar.
5. **Problems** — each in its own `task` block titled `№ 18.XXX · short name`. Inside:
   - the full statement (from the pasted scan, faithful in meaning);
   - `\medskip`, then the formal solution: **$\Omega$** (what an elementary outcome is, whether order matters, whether repetitions are allowed), $N(\Omega)$ or the measure, **events in words first, then formally**, the formula in general form, then the substitution of numbers;
   - every answer in `\ans{…}`, preferably an irreducible fraction plus a decimal approximation (`\ans{\tfrac{48}{95}\approx0{,}505}`; use the decimal separator of the output language);
   - if there are several answers (events A, B, C…) — an `itemize` list, each answer on its own line after `\\ $\Rightarrow$`;
   - where useful — a short grey note `{\small\color{muted} …}` (e.g. "the events are dependent" or a conclusion after Bayes).
6. **TikZ figures** — mandatory wherever the scan had them or where the text is hard to follow without them: a number line for 1-D geometric probability, a square with a strip for the meeting problem, a cube with a cut-off pyramid, a hypothesis tree for total probability/Bayes, a partition of $\Omega$ into $H_i$, a circuit diagram. A figure usually goes into a `minipage` to the right of the text (text ≈0.55–0.6, figure ≈0.37–0.42 of the width). Figure colors: only `accent`, `warn`, `muted`, `accentbg` (and tints such as `accent!25`, `warn!35`, `muted!12`).
7. **Homework** — at the very end, one line: a `keybox` with a bold teal "Homework:" and the numbers. Check the numbers against the scan.

Text style: scientific terms, no "obviously". Decimal comma in formulas where the language uses it (`0{,}8`), decimal point otherwise. Be detailed without padding: every computation must be explained (why order matters, why there are no repetitions, why $A\subset B$, etc.).

## Template (do not change, except running headers and language setup)

Compilation: `xelatex` (two passes). Fonts DejaVu Serif / Sans / Sans Mono + DejaVu Math TeX Gyre. If missing, install `fonts-dejavu`; TeX needs the packages `polyglossia`, `unicode-math`, `tcolorbox`, `tikz`, `titlesec`, `enumitem`, `booktabs`, `needspace`.

The template below is the Russian version. For another language, translate the text parts (header, running headers, box texts) and change the polyglossia language lines as described in "Language rule".

```latex
\documentclass[11pt,a4paper]{article}
\usepackage[a4paper,margin=2cm,top=1.6cm,bottom=1.6cm]{geometry}
\usepackage{fontspec}
\usepackage{amsmath,amssymb}
\usepackage{unicode-math}
\setmainfont{DejaVu Serif}[Scale=0.89]
\setsansfont{DejaVu Sans}[Scale=0.89]
\setmonofont{DejaVu Sans Mono}[Scale=0.85]
\setmathfont{DejaVu Math TeX Gyre}
\usepackage{polyglossia}
\setdefaultlanguage{russian}
\setotherlanguage{english}
\newfontfamily\cyrillicfont{DejaVu Serif}[Scale=0.89]
\newfontfamily\cyrillicfontsf{DejaVu Sans}[Scale=0.89]
\newfontfamily\cyrillicfonttt{DejaVu Sans Mono}[Scale=0.85]
\usepackage{xcolor}
\definecolor{accent}{HTML}{0F7B72}
\definecolor{accentbg}{HTML}{E8F4F2}
\definecolor{warn}{HTML}{B5591C}
\definecolor{warnbg}{HTML}{FBF0E8}
\definecolor{muted}{HTML}{5F6368}
\usepackage[most]{tcolorbox}
\usepackage{booktabs,array,multicol}
\usepackage{enumitem}
\setlist{itemsep=2pt,topsep=3pt}
\setlist[itemize]{label={\color{accent}\textbullet}}
\usepackage{titlesec}
\titleformat{\section}{\sffamily\Large\bfseries\color{accent}}{\thesection.}{0.5em}{}[{\color{accent}\titlerule[0.6pt]}]
\titleformat{\subsection}{\sffamily\large\bfseries}{\thesubsection.}{0.5em}{}
\titlespacing*{\section}{0pt}{11pt}{6pt}
\titlespacing*{\subsection}{0pt}{10pt}{5pt}
\usepackage{fancyhdr}
\pagestyle{fancy}\fancyhf{}
\renewcommand{\headrulewidth}{0.4pt}
\fancyhead[L]{\sffamily\small\color{muted}ТВиМС · Семинар N}
\fancyhead[R]{\sffamily\small\color{muted}<Короткая тема семинара>}
\fancyfoot[C]{\sffamily\small\thepage}
\usepackage{tikz}\usetikzlibrary{patterns,arrows.meta}
\usepackage{needspace}
\usepackage[hidelinks]{hyperref}
\setlength{\parindent}{0pt}\setlength{\parskip}{4pt}

% teal box: key takeaway, important consequences, homework
\newtcolorbox{keybox}[1][]{enhanced,breakable,colback=accentbg,colframe=accent,boxrule=0pt,leftrule=3pt,arc=2pt,left=8pt,right=8pt,top=5pt,bottom=5pt,#1}
% orange box: warnings, model adequacy, administrative notes
\newtcolorbox{warnbox}[1][]{enhanced,colback=warnbg,colframe=warn,boxrule=0pt,leftrule=3pt,arc=2pt,left=8pt,right=8pt,top=5pt,bottom=5pt,#1}
% problem card (does not break across pages)
\newtcolorbox{task}[1]{enhanced,colback=white,colframe=accent!60,boxrule=0.6pt,arc=3pt,left=9pt,right=9pt,top=6pt,bottom=6pt,
  title={\sffamily\bfseries #1},coltitle=white,colbacktitle=accent,fonttitle=\sffamily}
% same, but breakable — only for very long problems
\newtcolorbox{taskb}[1]{enhanced,breakable,colback=white,colframe=accent!60,boxrule=0.6pt,arc=3pt,left=9pt,right=9pt,top=6pt,bottom=6pt,
  title={\sffamily\bfseries #1},coltitle=white,colbacktitle=accent,fonttitle=\sffamily}
% answer in a teal frame
\newcommand{\ans}[1]{\tcbox[on line,colback=accentbg,colframe=accent,boxrule=0.5pt,arc=2pt,left=3pt,right=3pt,top=1pt,bottom=1pt]{$\displaystyle #1$}}

\begin{document}

\begin{center}
{\sffamily\small\color{muted} Теория вероятностей и математическая статистика}\\[4pt]
{\sffamily\huge\bfseries Семинар N}\\[4pt]
{\sffamily\large <Полная тема семинара>}
\end{center}
\vspace{2pt}

\begin{keybox}
\textbf{Ключевой вывод.} …
\end{keybox}

\section{…}
…

\begin{task}{№ 18.XXX · короткое название}
Условие задачи…
\medskip

Исход — … (порядок важен, повторы возможны):
\[
\Omega=\{\dots\},\qquad N(\Omega)=\dots
\]
\begin{itemize}
  \item $A$ — «…»: $A=\{\dots\}$, \ $N(A)=\dots$\\ $\Rightarrow$ \ans{P(A)=\tfrac{8}{27}}
\end{itemize}
\end{task}

\begin{keybox}[top=3pt,bottom=3pt]
{\sffamily\bfseries\color{accent}Домашнее задание:}\quad № 18.xx, \ 18.yy, \ 18.zz
\end{keybox}

\end{document}
```

### Palette (for reference)
| Color | Where it is used |
|---|---|
| `accent` #0F7B72 (teal) | section headings and the rule under them, problem headers, list bullets, answer frames, "correct" elements in figures |
| `accentbg` #E8F4F2 | background of `keybox` and `\ans` |
| `warn` #B5591C (terracotta) | `warnbox`, complements/unfavorable regions in figures, "✗" |
| `warnbg` #FBF0E8 | background of `warnbox` |
| `muted` #5F6368 (grey) | running headers, header subtitle, notes, auxiliary figure lines |

## Technical pitfalls (must be handled)

- **Cyrillic inside formulas** is not rendered (Missing character). Always wrap it in `\text{…}`: `\{\text{к},\text{ж},\text{с},\text{ц}\}`, `\underbrace{\text{К}_1,\dots,\text{К}_{12}}_{12}`. For frequently used notation define a macro: `\newcommand{\Sp}{\text{Сп}}`. (The same applies to any non-Latin script.)
- **Check mark / cross**: `\textcolor{accent}{\textsf{✓}}` and `\textcolor{warn}{$\times$}` (`\checkmark` is missing in this font).
- **Do not use `\tag` as the name of your own command** (conflicts with amsmath).
- **`task` cards do not break.** If a problem is longer than about 2/3 of a page and leaves a big gap, use `taskb`.
- **Dangling headings**: before a `\section` followed by a table or a large block, put `\needspace{12\baselineskip}`.
- **Long derivations**: split into lines (`gather*`, `aligned`, several `\[ … \]`). No formulas sticking out of the margins or overlapping a figure in the neighboring `minipage`.
- **Homework must not end up alone on the last page**: make it a one-line `keybox` and tighten spacing if necessary.
- A note in regular font can be added to a problem header: `{№ 18.233 · name \ {\normalfont\small(pay attention for the test)}}`.
- For a 3-D figure in the scan, choose a projection where the axes do not go inside the solid and sections do not turn into a "blade". This works well: `x={(-0.5cm,-0.42cm)},y={(1cm,0cm)},z={(0cm,1cm)}`; hidden edges dashed, regions labeled ($A$, $\bar A$).

## Quality control before sending

1. `grep -c 'Missing character' *.log` → must be **0**.
2. `grep Overfull *.log`: fix everything above ~15pt.
3. Render all pages (`pdftoppm -r 70`), stitch them into one image and **look at it**: no text overlapping figures, no dangling headings, figure labels not merging, no half-empty pages caused by unbreakable blocks.
4. Check every answer, problem number and homework number against the original scan once more.

## Reply format

- Send the PDF.
- Then briefly, as a list: **what was corrected relative to the text description** (was → became, referring to the place in the scan) and **what was added beyond the seminar** (computed answers, reconstructed statements). If something should be checked against the problem book, say so directly.
- Do not retell the content of the summary; it is in the file.
- Write this reply in the language of the input as well.
