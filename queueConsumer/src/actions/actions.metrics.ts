import { makeCounterProvider } from '@willsoto/nestjs-prometheus';

export const ACTION_LOCALITY_LANDED_RANK_METRIC =
    'kleinkram_action_locality_landed_rank_total';

export const ACTION_METRIC_PROVIDERS = [
    makeCounterProvider({
        name: ACTION_LOCALITY_LANDED_RANK_METRIC,
        help: 'Count of Action runs by the preference rank of the node they actually landed on ("1" = top-ranked cache-tier node, "2" = second, ... "other" = landed outside the ranked cache-tier list, "unknown" = node could not be determined)',
        labelNames: ['rank'],
    }),
];
