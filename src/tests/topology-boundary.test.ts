import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TwinStore } from '../domain/store';
import { TopologyService } from '../services/topology-service';
import { RootCauseService } from '../services/root-cause-service';
import { TopologyVersion } from '../domain/types';

function topology(version:number, effectiveAt:number):TopologyVersion {
  return {
    version,
    effectiveAt,
    edges: [
      { from: 'pump', to: 'reactor', weight: 0.8 },
      { from: 'valve', to: 'pump', weight: 0.4 }
    ],
    nodes: [
      { id: 'pump', kind: 'pump' },
      { id: 'reactor', kind: 'reactor' }
    ],
    metadata: { source: 'cad', revision: `r${version}` }
  };
}

function setup() {
  const store = new TwinStore();
  const topologyService = new TopologyService(store);
  const causes = new RootCauseService(store, topologyService);
  return { store, topologyService, causes };
}

test('publish: mutating the input object after publishing does not change the stored snapshot or the publish response', () => {
  const { store, topologyService } = setup();
  const input = topology(1, 100);
  const published = topologyService.publish(input);

  input.version = 999 as unknown as number;
  input.effectiveAt = 999;
  input.edges[0].weight = 0.01;
  input.edges.push({ from: 'rogue', to: 'reactor', weight: 5 });
  input.nodes!.push({ id: 'rogue' });
  input.metadata!.source = 'tampered';

  assert.equal(store.topology[0].version, 1);
  assert.equal(store.topology[0].effectiveAt, 100);
  assert.equal(store.topology[0].edges[0].weight, 0.8);
  assert.equal(store.topology[0].edges.length, 2);
  assert.equal(store.topology[0].nodes!.length, 2);
  assert.equal(store.topology[0].metadata!.source, 'cad');
  assert.equal(published.version, 1);
  assert.equal(published.edges[0].weight, 0.8);
  assert.equal(published.edges.length, 2);
  assert.equal(published.metadata!.source, 'cad');
});

test('publish response: mutating nested edges/nodes/metadata of the returned object does not leak into later queries', () => {
  const { topologyService } = setup();
  const published = topologyService.publish(topology(1, 100));

  published.edges[0].from = 'tampered';
  published.edges[0].weight = 0;
  published.nodes![0].id = 'tampered';
  published.metadata!.revision = 'tampered';
  delete published.metadata!.source;

  const again = topologyService.current(150);
  assert.deepEqual(again.edges, topology(1, 100).edges);
  assert.deepEqual(again.nodes, topology(1, 100).nodes);
  assert.deepEqual(again.metadata, { source: 'cad', revision: 'r1' });
});

test('query result: mutating nested arrays/objects/metadata of a query response never reaches storage, and repeated queries keep identical structure', () => {
  const { store, topologyService } = setup();
  topologyService.publish(topology(1, 100));

  const first = topologyService.current(200);
  first.edges.length = 0;
  first.nodes![0].id = 'x';
  first.metadata!.source = 'x';
  (first as any).extra = { nested: true };

  const second = topologyService.current(200);
  assert.equal(second.edges.length, 2);
  assert.equal(second.edges[0].from, 'pump');
  assert.equal(second.nodes![0].id, 'pump');
  assert.equal(second.metadata!.source, 'cad');
  assert.equal((second as any).extra, undefined);

  // Stored snapshot is structurally intact and defensively frozen.
  assert.ok(Object.isFrozen(store.topology[0]));
  assert.ok(Object.isFrozen(store.topology[0].edges[0]));
  assert.throws(() => { (store.topology[0].edges as any).push({}); }, TypeError);
});

test('impact results are independent edge objects with fresh trace ids and do not share storage references', () => {
  const { store, topologyService } = setup();
  topologyService.publish(topology(1, 100));

  const a = topologyService.impact('pump', 200);
  const b = topologyService.impact('pump', 200);
  a[0].weight = 999;
  (a[0] as any).marked = true;

  assert.notEqual(a[0], b[0]);
  assert.notEqual(a[0].traceId, b[0].traceId);
  assert.equal(b[0].weight, 0.8);
  assert.equal((b[0] as any).marked, undefined);
  assert.equal(store.topology[0].edges[0].weight, 0.8);
});

test('cross-version: marks on one version response do not pollute other versions; version selection by effective time is preserved', () => {
  const { store, topologyService } = setup();
  topologyService.publish(topology(1, 100));
  topologyService.publish(topology(2, 300));

  // Mutate a v1 historical response after v2 has already been published.
  const v1 = topologyService.current(200);
  v1.edges[0].weight = 0;
  v1.edges.push({ from: 'ghost', to: 'reactor', weight: 9 });
  v1.nodes!.push({ id: 'ghost' });
  v1.metadata!.revision = 'ghost';

  const v1Again = topologyService.current(200);
  const v2 = topologyService.current(300);
  const v2Later = topologyService.current(999);

  assert.equal(v1Again.version, 1);
  assert.equal(v1Again.edges.length, 2);
  assert.equal(v1Again.edges[0].weight, 0.8);
  assert.equal(v1Again.metadata!.revision, 'r1');
  assert.equal(v2.version, 2);
  assert.equal(v2.metadata!.revision, 'r2');
  assert.deepEqual(v2.edges, v2Later.edges);
  assert.notStrictEqual(v2, v2Later);

  // Selection behavior: before any effective version -> error; boundary inclusive.
  assert.throws(() => topologyService.current(99), /no effective topology/);
  assert.equal(topologyService.current(100).version, 1);
  assert.equal(topologyService.current(300).version, 2);

  // Stored snapshots remain independent of each other.
  assert.notStrictEqual(store.topology[0].edges, store.topology[1].edges);
});

test('concurrent reads: interleaved reads and caller mutations all observe independent copies', async () => {
  const { topologyService } = setup();
  topologyService.publish(topology(1, 100));

  const seen = await Promise.all(
    Array.from({ length: 20 }, async (_, i) => {
      await Promise.resolve(); // yield to interleave
      const view = topologyService.current(150);
      await Promise.resolve();
      view.edges[0].weight = i; // caller-local mutation
      (view.metadata as any).reader = i;
      return { weight: view.edges[0].weight, reader: (view.metadata as any).reader };
    })
  );

  seen.forEach((s, i) => assert.deepEqual(s, { weight: i, reader: i }));
  const clean = topologyService.current(150);
  assert.equal(clean.edges[0].weight, 0.8);
  assert.equal((clean.metadata as any).reader, undefined);
});

test('root-cause analysis reentry: analyst marks on a local analysis view and repeated/reentrant analyses cannot corrupt snapshots or each other', () => {
  const { store, topologyService, causes } = setup();
  topologyService.publish(topology(1, 100));
  topologyService.publish(topology(2, 300));
  store.incidents.set('inc-1', {
    id: 'inc-1', severity: 'high', status: 'open',
    assetIds: ['reactor', 'pump'], detectedAt: 100, evidence: []
  } as any);

  // Analyst previews the topology once and marks it locally, as described in
  // the workflow: view topology, then tag edges/nodes in a scratch context.
  const scratch = topologyService.view(100);
  scratch.edges.forEach(e => { (e as any).visited = true; });
  scratch.edges.push({ from: 'fake', to: 'reactor', weight: 1 });
  scratch.nodes!.push({ id: 'fake' });
  (scratch.metadata as any).analyst = 'alice';

  const first = causes.analyze('inc-1');
  const second = causes.analyze('inc-1'); // reentrant second pass
  assert.deepEqual(first, second);
  // pump->reactor is reached from both asset ids (pre-existing flatMap
  // expansion); both candidates still point at the untouched snapshot data.
  assert.equal(first.candidates.length, 2);
  for(const c of first.candidates){
    assert.deepEqual(c, { assetId: 'pump', weight: 0.8, reason: 'topology dependency' });
  }

  // Neither the scratch marks nor any internal analysis marks reached storage
  // or ordinary query results.
  const v1 = topologyService.current(100);
  const v2 = topologyService.current(400);
  assert.equal(v1.edges.length, 2);
  assert.equal((v1.edges[0] as any).visited, undefined);
  assert.equal((v1.metadata as any).analyst, undefined);
  assert.equal(v2.nodes!.length, 2);
  assert.equal(v2.edges.length, 2);

  // Analyzing at v2 time picks v2 independently of the v1 scratch context.
  store.incidents.set('inc-2', {
    id: 'inc-2', severity: 'high', status: 'open',
    assetIds: ['reactor'], detectedAt: 400, evidence: []
  } as any);
  const onV2 = causes.analyze('inc-2');
  assert.deepEqual(onV2.candidates, [{ assetId: 'pump', weight: 0.8, reason: 'topology dependency' }]);
});

test('sequential versioning rules remain enforced', () => {
  const { topologyService } = setup();
  topologyService.publish(topology(1, 100));
  assert.throws(() => topologyService.publish(topology(3, 200)), /sequential/);
  topologyService.publish(topology(2, 200));
  assert.equal(topologyService.current(200).version, 2);
});
