#!/usr/bin/env python3
"""Add the FAKEMOTE module to a d2x cIOS Installer ciosmaps.xml.

For every <base ios="57"> / <base ios="58"> entry: increase contentscount and
modulescount by one and append
    <content id="0x.." module="FAKEMOTE" tmdmoduleid="-1"/>
after the last <content module=...> entry, with id = highest id + 1.
This mirrors the manual steps in the fakemote README.
"""
import re
import sys

BASES = ("57", "58")


def patch_base(block: str) -> str:
    if 'module="FAKEMOTE"' in block:
        return block  # already patched
    ids = [int(x, 16) for x in re.findall(r'<content\s+id="(0x[0-9a-fA-F]+)"', block)]
    new_id = max(ids) + 1
    head = re.match(r'<base\s[^>]*>', block).group(0)
    new_head = re.sub(r'contentscount="(\d+)"', lambda m: f'contentscount="{int(m.group(1)) + 1}"', head)
    new_head = re.sub(r'modulescount="(\d+)"', lambda m: f'modulescount="{int(m.group(1)) + 1}"', new_head)
    block = new_head + block[len(head):]
    mods = list(re.finditer(r'<content\s[^>]*module="[^"]+"[^>]*/>', block))
    if not mods:
        raise SystemExit("no <content module=...> entries found")
    last = mods[-1]
    indent = re.search(r'([ \t]*)$', block[:last.start()]).group(1)
    nl = '\r\n' if '\r\n' in block else '\n'
    entry = f'{nl}{indent}<content id="0x{new_id:x}" module="FAKEMOTE" tmdmoduleid="-1"/>'
    return block[:last.end()] + entry + block[last.end():]


def main(path: str) -> None:
    xml = open(path, encoding="utf-8", errors="replace", newline="").read()
    count = 0
    for ios in BASES:
        pat = re.compile(r'<base\s+ios="%s"[^>]*>.*?</base>' % ios, re.S)
        def repl(m):
            nonlocal count
            count += 1
            return patch_base(m.group(0))
        xml = pat.sub(repl, xml)
    if count == 0:
        raise SystemExit("no base 57/58 entries found in " + path)
    open(path, "w", encoding="utf-8", newline="").write(xml)
    print(f"patched {count} base entries in {path}")


if __name__ == "__main__":
    main(sys.argv[1])
