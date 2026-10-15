import { rankNodes } from '../helper/rendezvous-hash';

export interface NodeRank {
    home: string;
    fallbacks: string[];
}

/**
 * Ranks `eligibleNodeNames` (already filtered to the job's class - cpu or
 * gpu nodes, see spec §6.2) for `dataKey` via the existing HRW scorer, and
 * splits the result into a home node plus `fallbackDepth - 1` fallbacks
 * (spec §8.1, §3 "Fallback list"). Reuses rankNodes unchanged rather than
 * the spec's weighted rendezvous form, so this stays comparable with the
 * node ranking `kleinkram_action_locality_landed_rank_total` already
 * records for the tiered-affinity system.
 */
export function rankForJob(
    dataKey: string,
    eligibleNodeNames: readonly string[],
    fallbackDepth: number,
): NodeRank {
    if (eligibleNodeNames.length === 0) {
        throw new Error('Cannot rank a job against an empty eligible node set');
    }
    const ranked = rankNodes(dataKey, [...eligibleNodeNames]);
    return {
        home: ranked[0] as string,
        fallbacks: ranked.slice(1, fallbackDepth),
    };
}
