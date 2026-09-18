"""Unit tests for on-disk page-number reconciliation (serve-svg-editor.renumber_svg_text / canonical_page)."""
import importlib.util, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
spec = importlib.util.spec_from_file_location('srv', pathlib.Path(__file__).with_name('serve-svg-editor.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

cases = [
    # (svg, new position, expected output or None=unchanged, expected changed flag)
    ('<svg><text id="page-number" x="1">04</text></svg>', 3, '<svg><text id="page-number" x="1">03</text></svg>', True),
    ('<svg><text id="page-number">03</text></svg>', 3, None, False),                                   # already correct
    ('<svg><text id="page-number">  04\n</text></svg>', 12, '<svg><text id="page-number">  12\n</text></svg>', True),  # whitespace kept
    ('<svg><text id="page-number"><tspan x="0">04</tspan></text></svg>', 7, '<svg><text id="page-number"><tspan x="0">07</tspan></text></svg>', True),
    ('<svg><text id="page-number"><tspan>0</tspan><tspan>4</tspan></text></svg>', 7, None, False),    # ambiguous → untouched
    ('<svg><text id="page-number">Page</text></svg>', 7, None, False),                                 # non-numeric → untouched
    ('<svg><text id="other">04</text></svg>', 7, None, False),                                         # no slot → untouched
    ('<svg><text id="page-number">4</text><text>04</text></svg>', 9, '<svg><text id="page-number">09</text><text>04</text></svg>', True),  # only the slot changes
    ('<svg><text id="page-number">099</text></svg>', 100, '<svg><text id="page-number">100</text></svg>', True),   # 3-digit
]
failed = 0
for src, n, exp, chg in cases:
    out, changed = m.renumber_svg_text(src, n)
    ok = changed == chg and (out == src if exp is None else out == exp)
    failed += not ok
    print(('PASS' if ok else 'FAIL'), repr(src[:48]), '->', repr(out[:48]), changed)

for value, expect in [('28.2', 28.2), ('17', 17), (17, 17), (13.1, 13.1), (' 5 ', 5), ('abc', 'abc'), (True, True)]:
    got = m.canonical_page(value)
    ok = got == expect and type(got) is type(expect)
    failed += not ok
    print(('PASS' if ok else 'FAIL'), 'canonical_page', repr(value), '->', repr(got))

print('renumber tests:', 'ALL OK' if not failed else f'{failed} FAILED')
sys.exit(1 if failed else 0)
