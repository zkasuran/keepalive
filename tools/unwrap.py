#!/usr/bin/env python3
"""Unwrap hard-wrapped markdown paragraphs into one line each.

Forem renders with hardbreaks on, so every newline inside a paragraph becomes a <br>.
A source file wrapped at 88 characters for readability therefore publishes as a ragged
column with breaks in the middle of sentences. This joins each paragraph back into a
single line and leaves everything that is line-sensitive alone: YAML front matter, fenced
code blocks, headings, tables, liquid tags, horizontal rules and blank lines.

List items keep their markers. Continuation lines fold into the item they belong to.

    python3 tools/unwrap.py POST.md            print the unwrapped version
    python3 tools/unwrap.py POST.md --write     rewrite the file in place
"""
import re
import sys

FENCE = re.compile(r"^\s*(```|~~~)")
HEADING = re.compile(r"^\s{0,3}#{1,6}\s")
LIST = re.compile(r"^(\s*)([-*+]|\d{1,3}[.)])\s+")
PASSTHROUGH = re.compile(r"^\s*(\||>|\{%|<|!\[|---\s*$|===\s*$)")


def unwrap(text):
    lines = text.split("\n")
    out = []
    i = 0

    # YAML front matter, verbatim
    if lines and lines[0].strip() == "---":
        out.append(lines[0])
        i = 1
        while i < len(lines) and lines[i].strip() != "---":
            out.append(lines[i])
            i += 1
        if i < len(lines):
            out.append(lines[i])
            i += 1

    in_fence = False
    para = []

    def flush():
        if para:
            out.append(" ".join(s.strip() for s in para).strip())
            para.clear()

    while i < len(lines):
        line = lines[i]
        if FENCE.match(line):
            flush()
            in_fence = not in_fence
            out.append(line)
            i += 1
            continue
        if in_fence:
            out.append(line)
            i += 1
            continue
        if not line.strip():
            flush()
            out.append("")
            i += 1
            continue
        if HEADING.match(line) or PASSTHROUGH.match(line):
            flush()
            out.append(line.rstrip())
            i += 1
            continue
        m = LIST.match(line)
        if m:
            flush()
            indent, marker = m.group(1), m.group(2)
            item = [line.rstrip()]
            i += 1
            # fold continuation lines, stopping at a blank line or the next marker
            while i < len(lines) and lines[i].strip() and not LIST.match(lines[i]) \
                    and not HEADING.match(lines[i]) and not PASSTHROUGH.match(lines[i]) \
                    and not FENCE.match(lines[i]):
                item.append(lines[i].strip())
                i += 1
            out.append(" ".join(s.strip() if n else s for n, s in enumerate(item)))
            continue
        para.append(line)
        i += 1
    flush()

    # collapse any run of blank lines to one, and end with a single newline
    text = "\n".join(out)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.rstrip() + "\n"


if __name__ == "__main__":
    path = sys.argv[1]
    src = open(path, encoding="utf-8").read()
    result = unwrap(src)
    if "--write" in sys.argv:
        open(path, "w", encoding="utf-8").write(result)
        before = sum(1 for l in src.split("\n") if l.strip())
        after = sum(1 for l in result.split("\n") if l.strip())
        print("%s: %d non-blank lines -> %d" % (path, before, after))
    else:
        sys.stdout.write(result)
