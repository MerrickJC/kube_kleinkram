import { createHash } from 'node:crypto';

/**
 * Ranks `nodeNames` for `key` using rendezvous (highest-random-weight)
 * hashing: sha256(`${key}:${node}`) per node, sorted descending
 */
function compareWeightsDescending(a: string, b: string): number {
    if (a === b) return 0;
    return a > b ? -1 : 1;
}

export function rankNodes(key: string, nodeNames: string[]): string[] {
    const weighted = nodeNames.map((node) => ({
        node,
        weight: createHash('sha256').update(`${key}:${node}`).digest('hex'),
    }));
    weighted.sort((a, b) => compareWeightsDescending(a.weight, b.weight));
    return weighted.map(({ node }) => node);
}
