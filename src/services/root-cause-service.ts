import { TwinStore } from '../domain/store';
import { TopologyService } from './topology-service';

export class RootCauseService {
  constructor(private store:TwinStore, private topology:TopologyService){}

  analyze(incidentId:string){
    const incident = this.store.incidents.get(incidentId);
    if(!incident) throw new Error('incident not found');

    // Acquire a private analysis context once: every impact lookup below runs
    // against this same local view, never against stored snapshots or query
    // results. Temporary edge/node marks made by the analyst stay local and
    // cannot leak into later queries or concurrent/reentrant analyses.
    const context = this.topology.view(incident.detectedAt);
    const graph = incident.assetIds.flatMap(id => this.topology.impactWithin(context, id));
    const upstream = graph
      .filter(e => e.to === incident.assetIds[0])
      .sort((a,b) => b.weight - a.weight);

    return {
      incidentId,
      confidence: Math.min(.99, .55 + upstream.length * .1),
      candidates: upstream.map(e => ({assetId:e.from, weight:e.weight, reason:'topology dependency'}))
    };
  }
}
