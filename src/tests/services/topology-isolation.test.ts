import test from 'node:test';
import assert from 'node:assert/strict';
import { TwinStore } from '../../domain/store';
import { TopologyVersion } from '../../domain/types';
import { TopologyService } from '../../services/topology-service';
import { TelemetryService } from '../../services/telemetry-service';
import { AnomalyService } from '../../services/anomaly-service';
import { RootCauseService } from '../../services/root-cause-service';

const makeVersion = (version:number, effectiveAt:number):TopologyVersion => ({
  version,
  effectiveAt,
  nodes:[
    {id:'pump-1',kind:'pump',tags:['cooling','critical']},
    {id:'valve-1',kind:'valve',tags:['cooling']},
    {id:'reactor-1',kind:'reactor'},
  ],
  edges:[
    {from:'pump-1',to:'valve-1',weight:0.9},
    {from:'sensor-1',to:'valve-1',weight:0.7},
    {from:'valve-1',to:'reactor-1',weight:0.4},
  ],
  metadata:{site:'plant-a',revision:{author:'ops',labels:['base']}},
});

// Simulates an analyst locally marking up a topology response: nested arrays,
// object properties and metadata are all mutated.
const scribble = (v:TopologyVersion) => {
  v.edges[0].weight = 0.01;
  v.edges.push({from:'ghost',to:'valve-1',weight:99});
  v.nodes![0].tags!.push('suspect');
  v.nodes![1].kind = 'sensor';
  (v.metadata as any).site = 'tampered';
  (v.metadata as any).revision.author = 'mallory';
  (v.metadata as any).revision.labels.push('tampered');
};

test('publish deep-copies its input: mutating the published object afterwards never reaches the store', () => {
  const svc = new TopologyService(new TwinStore());
  const input = makeVersion(1, 1000);
  svc.publish(input);
  scribble(input);
  assert.deepEqual(svc.current(1500), makeVersion(1, 1000));
});

test('publish returns a snapshot detached from both the input and the store', () => {
  const svc = new TopologyService(new TwinStore());
  const input = makeVersion(1, 1000);
  const returned = svc.publish(input);
  assert.notEqual(returned, input);
  assert.deepEqual(returned, input);
  scribble(returned);
  assert.deepEqual(input, makeVersion(1, 1000), 'input must not be affected via the returned object');
  assert.deepEqual(svc.current(1500), makeVersion(1, 1000), 'stored snapshot must not be affected via the returned object');
});

test('current() hands out independent copies: local markings never reach stored history', () => {
  const svc = new TopologyService(new TwinStore());
  svc.publish(makeVersion(1, 1000));
  const first = svc.current(1500);
  scribble(first);
  const second = svc.current(1500);
  assert.deepEqual(second, makeVersion(1, 1000));
  assert.notEqual(second.edges, first.edges);
  assert.deepEqual(svc.current(1500), makeVersion(1, 1000), 're-querying stays pristine');
});

test('impact() results are detached: mutating them changes neither later impact nor current results', () => {
  const svc = new TopologyService(new TwinStore());
  svc.publish(makeVersion(1, 1000));
  const impacts = svc.impact('valve-1', 1500);
  assert.equal(impacts.length, 3);
  assert.ok(impacts.every(e => typeof (e as any).traceId === 'string'), 'traceId behaviour preserved');
  assert.deepEqual(impacts.map(e => e.weight), [0.9, 0.7, 0.4], 'weight ordering preserved');
  impacts[0].weight = 0.0001;
  impacts[0].from = 'ghost';
  impacts.push({from:'x', to:'y', weight:1} as any);
  const again = svc.impact('valve-1', 1500);
  assert.deepEqual(again.map(e => ({from:e.from, to:e.to, weight:e.weight})), [
    {from:'pump-1', to:'valve-1', weight:0.9},
    {from:'sensor-1', to:'valve-1', weight:0.7},
    {from:'valve-1', to:'reactor-1', weight:0.4},
  ]);
  assert.deepEqual(svc.current(1500), makeVersion(1, 1000));
});

test('versions stay isolated across effectiveAt selection: marking v1 never pollutes v2 or v1 re-reads', () => {
  const svc = new TopologyService(new TwinStore());
  svc.publish(makeVersion(1, 1000));
  const v2 = makeVersion(2, 2000);
  v2.edges = [{from:'reactor-1', to:'valve-1', weight:0.8}];
  v2.metadata = {site:'plant-b', revision:{author:'ops', labels:['v2']}};
  svc.publish(v2);

  const atV1 = svc.current(1500);
  assert.equal(atV1.version, 1);
  scribble(atV1);

  const atV2 = svc.current(2500);
  assert.equal(atV2.version, 2, 'version selection by effectiveAt unchanged');
  assert.deepEqual(atV2.edges, [{from:'reactor-1', to:'valve-1', weight:0.8}]);
  assert.equal((atV2.metadata as any).site, 'plant-b');

  const v1Again = svc.current(1500);
  assert.equal(v1Again.version, 1);
  assert.deepEqual(v1Again, makeVersion(1, 1000), 'v1 history is pristine after being marked up');

  assert.equal(svc.impact('valve-1', 1500).length, 3);
  assert.deepEqual(svc.impact('valve-1', 2500).map(e => e.from), ['reactor-1']);
});

test('concurrent readers each get their own copy and cannot interfere', async () => {
  const svc = new TopologyService(new TwinStore());
  svc.publish(makeVersion(1, 1000));
  const reads = await Promise.all(Array.from({length:16}, async () => ({
    version: svc.current(1500),
    impact: svc.impact('valve-1', 1500),
  })));
  for (const {version, impact} of reads) {
    assert.deepEqual(version, makeVersion(1, 1000));
    assert.equal(impact.length, 3);
  }
  for (const {version, impact} of reads) {
    scribble(version);
    impact.forEach(e => { e.weight = -1; });
  }
  assert.deepEqual(svc.current(1500), makeVersion(1, 1000));
  assert.deepEqual(svc.impact('valve-1', 1500).map(e => e.weight), [0.9, 0.7, 0.4]);
});

test('root cause analysis is re-entrant and immune to markings on topology responses', () => {
  const store = new TwinStore();
  const topology = new TopologyService(store);
  const telemetry = new TelemetryService(store);
  const anomalies = new AnomalyService(store);
  const causes = new RootCauseService(store, topology);

  topology.publish(makeVersion(1, 1000));
  telemetry.ingest({assetId:'valve-1', metric:'pressure', value:12, unit:'bar', observedAt:4000, quality:'good'});
  telemetry.ingest({assetId:'valve-1', metric:'pressure', value:15, unit:'bar', observedAt:5000, quality:'good'});
  const incident = anomalies.detect('valve-1', 'pressure', 10);
  assert.ok(incident);

  // analyst views the topology, marks edges/nodes/metadata, then queries the impact chain
  const view = topology.current(incident.detectedAt);
  scribble(view);
  const markedImpact = topology.impact('valve-1', incident.detectedAt);
  markedImpact.forEach(e => { e.weight = 0; });

  const expectedCandidates = [
    {assetId:'pump-1', weight:0.9, reason:'topology dependency'},
    {assetId:'sensor-1', weight:0.7, reason:'topology dependency'},
  ];
  const first = causes.analyze(incident.id);
  assert.equal(first.incidentId, incident.id);
  assert.equal(first.confidence, 0.75);
  assert.deepEqual(first.candidates, expectedCandidates, 'analysis uses the pristine stored topology');

  first.candidates[0].weight = 12345;
  (first as any).confidence = 0;
  const second = causes.analyze(incident.id);
  assert.equal(second.confidence, 0.75);
  assert.deepEqual(second.candidates, expectedCandidates, 're-running analysis is unaffected by mutated results');
});

test('version sequencing and empty-topology errors are unchanged', () => {
  const svc = new TopologyService(new TwinStore());
  assert.throws(() => svc.current(0), (e:any) => e.code === 'NO_TOPOLOGY');
  svc.publish(makeVersion(1, 1000));
  assert.throws(() => svc.publish(makeVersion(3, 3000)), (e:any) => e.code === 'VERSION_GAP');
  svc.publish(makeVersion(2, 2000));
  assert.equal(svc.current(2500).version, 2);
});
