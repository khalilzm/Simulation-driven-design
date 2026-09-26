import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createRegionCatalog, applyRegionSplits } from '../server/src/design/layoutRegions.ts';
import { compileAllocation } from '../server/src/design/compileAllocation.ts';
import { outsideArea, geometryArea, unionRings, rectangle } from '../server/src/design/regionGeometry.ts';
import { diff } from 'martinez-polygon-clipping';
import { validateAgentModel } from '../server/src/model/validateAgent.ts';
import { validateModel } from '../server/src/model/validate.ts';
import { validateLayoutCompleteness } from '../server/src/model/layoutValidation.ts';

const fixtures = [
  ['rectangle', rectangle(0, 0, 12, 8)],
  ['l-shape', [[0, 0], [12, 0], [12, 4], [4, 4], [4, 10], [0, 10], [0, 0]]],
  ['angled', [[0, 0], [12, 0], [10, 9], [6, 5], [0, 8], [0, 0]]],
  ['gym', JSON.parse(fs.readFileSync(new URL('../server/test/fixtures/gym-outline.json', import.meta.url), 'utf8'))],
];
const reports = [];
for (const [name, boundary] of fixtures) {
  const durations = [], preparation = [], failures = [];
  let regionCount = 0, maximumOutsideArea = 0, maximumUncoveredArea = 0;
  for (let sample = 1; sample <= 25; sample++) {
    const start = performance.now();
    try {
      const catalog = createRegionCatalog(JSON.stringify({ boundary, origin: [0, 0] }));
      preparation.push(performance.now() - start);
      regionCount = catalog.regions.length;
      const splits = catalog.regions.filter((region) => region.area > 5).slice(0, 8).map((region, i) => ({
        regionId: region.id, axis: i % 2 ? 'x' : 'y', ratio: 0.2 + ((sample * 7 + i * 11) % 60) / 100,
      }));
      const cells = applyRegionSplits(catalog, splits);
      // 按实际位置分配功能色块，覆盖不同区域组合与切分比例。
      const xs = boundary.map(([x]) => x), minX = Math.min(...xs), width = Math.max(...xs) - minX;
      const buckets = Array.from({ length: 4 }, () => []);
      for (const cell of cells) {
        const coordinates = cell.boundary.map(([x]) => x);
        const center = (Math.min(...coordinates) + Math.max(...coordinates)) / 2;
        buckets[Math.min(3, Math.floor((center - minX) / width * 4))].push(cell.id);
      }
      const allocations = buckets.flatMap((regionIds, i) => regionIds.length
        ? [{ id: `zone-${i}`, usage: `测试功能区 ${i + 1}`, enclosed: false, regionIds }] : []);
      const { model } = compileAllocation({ splits, allocations }, catalog, 'rev-0001', true);
      const errors = [...validateAgentModel(model).errors, ...validateModel(model).errors, ...validateLayoutCompleteness(model, true)];
      if (errors.length) throw new Error(errors.join('; '));
      maximumOutsideArea = Math.max(maximumOutsideArea, ...model.spaces.map((space) => outsideArea(space.boundary, boundary)));
      maximumUncoveredArea = Math.max(maximumUncoveredArea, geometryArea(diff([boundary], unionRings(model.spaces.map((space) => space.boundary)))));
      durations.push(performance.now() - start);
    } catch (error) { failures.push({ sample, error: String(error) }); }
  }
  const percentile = (values, p) => values.length ? Number([...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1].toFixed(2)) : null;
  reports.push({ name, regionCount, samples: 25, failures, maximumOutsideArea, maximumUncoveredArea,
    preparationP50Ms: percentile(preparation, 0.5), fullGeometryP50Ms: percentile(durations, 0.5), fullGeometryP95Ms: percentile(durations, 0.95) });
}
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), scope: 'Synthetic spatial bands; geometry only, no online Agent inference or design-quality evaluation', reports }, null, 2));
if (reports.some((report) => report.failures.length || report.maximumOutsideArea > 1e-6 || report.maximumUncoveredArea > 1e-6)) process.exitCode = 1;
