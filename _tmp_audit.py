# Temporary audit script - deleted after use
import ast, hashlib, re
from pathlib import Path
from collections import defaultdict

files = sorted(p for p in Path(".").rglob("*.py")
               if not any(x in str(p) for x in (".git", "venv", "n8n_reference", "__pycache__", "site-packages")))
srcs = {f: f.read_text(encoding="utf-8") for f in files}
trees = {f: ast.parse(s) for f, s in srcs.items()}
app_files = [f for f in files if str(f).replace("\\", "/").startswith("app/")]
def norm(f): return str(f).replace("\\", "/")

top_defs = defaultdict(list)
nested_defs = defaultdict(list)
func_names_by_file = defaultdict(set)
for f in app_files:
    t = trees[f]
    for node in t.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            top_defs[node.name].append((f, node.lineno, node.end_lineno, node))
            func_names_by_file[f].add(node.name)
            if isinstance(node, ast.ClassDef):
                for sub in node.body:
                    if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        nested_defs[sub.name].append((f, node.name, sub.lineno, sub.end_lineno))
                        func_names_by_file[f].add(sub.name)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for sub in ast.walk(node):
                    if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)) and sub is not node:
                        nested_defs[sub.name].append((f, node.name, sub.lineno, sub.end_lineno))
                        func_names_by_file[f].add(sub.name)

class Coll(ast.NodeVisitor):
    def __init__(self):
        self.stack = []
        self.refs = defaultdict(set)
        self.root_names = set()
        self.strings = set()
        self.imported = {}
    def visit_FunctionDef(self, node): self._fn(node)
    def visit_AsyncFunctionDef(self, node): self._fn(node)
    def _fn(self, node):
        self.stack.append(node.name); self.generic_visit(node); self.stack.pop()
    def visit_Name(self, node):
        enc = self.stack[-1] if self.stack else "<module>"
        self.refs[node.id].add(enc)
        self.root_names.add(node.id)
        self.generic_visit(node)
    def visit_Attribute(self, node):
        n = node
        while isinstance(n, ast.Attribute): n = n.value
        if isinstance(n, ast.Name): self.root_names.add(n.id)
        enc = self.stack[-1] if self.stack else "<module>"
        self.refs[node.attr].add(enc)
        self.generic_visit(node)
    def visit_Constant(self, node):
        if isinstance(node.value, str): self.strings.add(node.value)
        self.generic_visit(node)
    def visit_ImportFrom(self, node):
        for a in node.names: self.imported[a.asname or a.name] = node.lineno
        self.generic_visit(node)
    def visit_Import(self, node):
        for a in node.names: self.imported[(a.asname or a.name).split(".")[0]] = node.lineno
        self.generic_visit(node)

colls = {}
for f in files:
    c = Coll(); c.visit(trees[f]); colls[f] = c

print("### A. TOP-LEVEL DEFS WITH ZERO REFS (app+tests+tools)")
dead0 = set()
total0 = 0
for name, sites in sorted(top_defs.items()):
    has_ref = any(c.refs.get(name) for c in colls.values())
    if not has_ref:
        for (f, ln, el, node) in sites:
            print("  %4d  %s:%d  %s" % (el - ln + 1, norm(f), ln, name))
            total0 += el - ln + 1
            dead0.add((norm(f), name))
print("  -- lines~%d" % total0)

print()
print("### B. TRANSITIVE DEAD (only referenced from dead funcs, same file)")
deadT = set(dead0)
changed = True
while changed:
    changed = False
    for name, sites in top_defs.items():
        for (f, ln, el, node) in sites:
            key = (norm(f), name)
            if key in deadT: continue
            refs = set()
            for f2, c in colls.items():
                if not norm(f2).startswith("app/"): continue
                for enc in c.refs.get(name, ()): refs.add((norm(f2), enc))
            if any(f2 == norm(f) and enc == "<module>" for f2, enc in refs): continue
            ok = bool(refs)
            for (f2, enc) in refs:
                if not (f2 == norm(f) and enc in func_names_by_file[f] and (f2, enc) in deadT):
                    ok = False; break
            if ok:
                deadT.add(key); changed = True
                print("  %4d  %s:%d  %s (only referenced from dead)" % (el - ln + 1, norm(f), ln, name))
print("  -- newly dead: %d" % (len(deadT) - len(dead0)))

print()
print("### C. BIG THREE STATUS")
for target in ("prepare_single_agent_result_context", "extract_single_agent_reply", "route_single_agent_phase"):
    sites = top_defs.get(target, [])
    if not sites:
        print("  %s: NOT DEFINED" % target)
        continue
    for (f, ln, el, node) in sites:
        rc = []
        for f2, c in colls.items():
            n = len(c.refs.get(target, ()))
            if n: rc.append("%sx%d" % (norm(f2), n))
        print("  %s  %s:%d (%d lines)  refs: %s" % (target, norm(f), ln, el - ln + 1, rc or "NONE"))

print()
print("### D. DUPLICATE FUNCTION BODIES (same name, >=2 app files)")
def bodyinfo(node, src):
    seg = ast.get_source_segment(src, node) or ""
    h = hashlib.sha1(re.sub(r"\s+", " ", seg).encode()).hexdigest()[:10]
    return h, len(seg.splitlines())
by_name = defaultdict(list)
for name, sites in top_defs.items():
    if isinstance(sites[0][3], ast.ClassDef): continue
    for (f, ln, el, node) in sites:
        h, n = bodyinfo(node, srcs[f])
        by_name[name].append((norm(f), ln, h, n))
dup_ident = dup_diff = 0
for name, lst in sorted(by_name.items()):
    if len(lst) > 1:
        hashes = set(h for _, _, h, _ in lst)
        verdict = "IDENTICAL" if len(hashes) == 1 else "DIFFERING"
        lines = ", ".join("%s:%d(%dL,%s)" % (fl, ln, n, h) for fl, ln, h, n in lst)
        print("  [%s] %s: %s" % (verdict, name, lines))
        if len(hashes) == 1: dup_ident += 1
        else: dup_diff += 1
print("  -- identical groups=%d differing=%d" % (dup_ident, dup_diff))

print()
print("### E. UNUSED IMPORTS")
cnt = 0
scan = app_files + [x for x in files if norm(x).startswith(("tests/", "tools/"))]
for f in sorted(scan):
    c = colls[f]
    unused = [(nm, ln) for nm, ln in c.imported.items() if nm not in c.root_names]
    if unused:
        print("  %s: %s" % (norm(f), unused))
        cnt += len(unused)
print("  -- total %d" % cnt)

print()
print("### F. SETTINGS KEYS DEFINED BUT NEVER USED")
cfgf = None
for f in app_files:
    if norm(f).endswith("app/core/config.py"): cfgf = f
if cfgf:
    keys = set()
    for node in ast.walk(trees[cfgf]):
        if isinstance(node, ast.ClassDef) and node.name == "Settings":
            for st in node.body:
                if isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name):
                    keys.add(st.target.id)
    used = set()
    for f2, c in colls.items():
        for nm in c.refs:
            if nm in keys: used.add(nm)
        for s in c.strings:
            for k in keys:
                if k in s: used.add(k)
    unused_keys = sorted(keys - used)
    print("  " + (", ".join(unused_keys) if unused_keys else "(none)"))
