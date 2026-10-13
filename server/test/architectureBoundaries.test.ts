import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const src = fileURLToPath(new URL('../src/', import.meta.url));
const geometry = path.join(src, 'geometry');

/** Include imports, re-exports and literal dynamic imports, including type-only dependencies. */
function dependencies(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

test('geometry depends only on its own modules, shared contracts and polygon clipping', () => {
  for (const name of fs.readdirSync(geometry).filter(name => name.endsWith('.ts'))) {
    for (const specifier of dependencies(path.join(geometry, name))) {
      if (specifier.startsWith('.')) {
        const resolved = path.resolve(geometry, specifier);
        assert.ok(resolved.startsWith(`${geometry}${path.sep}`), `${name} crosses the geometry boundary: ${specifier}`);
        assert.ok(fs.existsSync(`${resolved}.ts`), `${name} references a missing geometry module: ${specifier}`);
      } else {
        assert.ok(['@sdd/shared', 'martinez-polygon-clipping'].includes(specifier), `${name} imports ${specifier}`);
      }
    }
  }
});

test('the residential solver dependency graph has no local import cycles', () => {
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (file: string) => {
    const cycleAt = stack.indexOf(file);
    assert.equal(cycleAt, -1, `Import cycle: ${[...stack.slice(Math.max(0, cycleAt)), file].map(f => path.relative(src, f)).join(' → ')}`);
    if (visited.has(file)) return;
    stack.push(file);
    for (const specifier of dependencies(file).filter(s => s.startsWith('.'))) {
      const modulePath = path.resolve(path.dirname(file), specifier);
      const target = fs.existsSync(`${modulePath}.ts`) ? `${modulePath}.ts` : path.join(modulePath, 'index.ts');
      if (target.startsWith(src) && fs.existsSync(target)) visit(target);
    }
    stack.pop();
    visited.add(file);
  };
  visit(path.join(src, 'scenarios/residential/residentialSolver.ts'));
});

test('generic generation orchestration does not import a concrete scenario implementation',()=>{
  for(const name of ['design/runSpaceTurn.ts','routes/spaceTurn.ts']) {
    const file=path.join(src,name);
    for(const specifier of dependencies(file).filter(s=>s.startsWith('.'))) {
      const target=path.resolve(path.dirname(file),specifier);
      assert.ok(!target.startsWith(path.join(src,'scenarios/residential')),`${name} bypasses scene dispatch: ${specifier}`);
    }
  }
});

test('evaluation lifecycle does not import scene rules or concrete engines',()=>{
  for(const specifier of dependencies(path.join(src,'analysis/runtime/evaluation.ts'))) {
    assert.ok(['node:fs','@sdd/shared','./identity','./task'].includes(specifier),`Evaluation lifecycle imports ${specifier}`);
  }
});


test('workbench delegates residential input preparation instead of calling scene persistence APIs', () => {
  const app = fileURLToPath(new URL('../../web/src/App.tsx', import.meta.url));
  const source = ts.createSourceFile(app, fs.readFileSync(app, 'utf8'), ts.ScriptTarget.Latest, true);
  const sceneOperations = new Set(['interpretResidentialBrief', 'loadResidentialBrief', 'saveResidentialBrief',
    'briefTurnPlan', 'briefTurnReply', 'revealedBriefBoards', 'createResidentialBrief']);
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node)) continue;
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements)
      assert.ok(!sceneOperations.has(item.propertyName?.text ?? item.name.text), `App imports scene operation ${item.name.text}`);
  }
  const preparation = fileURLToPath(new URL('../../web/src/scenarios/residential/generation.ts', import.meta.url));
  for (const specifier of dependencies(preparation))
    assert.ok(['@sdd/shared', '../../workbench/scenarioGeneration'].includes(specifier), `Preparation depends on ${specifier}`);
});


test('viewer selection and rendering do not dispatch analysis by residential metadata', () => {
  for (const name of ['Viewer.tsx', 'Scene.ts', 'analysisLayers.ts', 'AnalysisLegend.tsx']) {
    const file = fileURLToPath(new URL(`../../web/src/viewer/${name}`, import.meta.url));
    for (const specifier of dependencies(file)) assert.ok(!specifier.includes('scenarios/'), `${name} imports a scenario`);
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node)) assert.notEqual(node.name.text, 'residentialBrief', `${name} selects rendering by residential metadata`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});


test('engine task lifecycle has no concrete engine dependency and runners do not persist task records', () => {
  for (const name of ['analysis/runtime/task.ts', 'analysis/runtime/engineResult.ts'])
    for (const specifier of dependencies(path.join(src, name)))
      assert.ok(!/\/(sunlight|pedestrian|daylight)\//.test(specifier), `${name} imports an engine implementation`);
  for (const name of ['daylight/run.ts', 'sunlight/run.ts', 'pedestrian/run.ts']) {
    const file = path.join(src, name), source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression))
        assert.ok(!['writeFileSync', 'renameSync', 'mkdirSync'].includes(node.expression.name.text), `${name} persists task lifecycle itself`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});
