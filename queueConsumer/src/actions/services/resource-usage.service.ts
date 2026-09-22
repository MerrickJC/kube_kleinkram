import { ActionEntity } from '@kleinkram/backend-common/entities/action/action.entity';
import { ResourceUsage } from '@kleinkram/shared';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import axios from 'axios';
import { Repository } from 'typeorm';
import logger from '../../logger';

interface PrometheusRangeResponse {
    data: { result: { values: [number, string][] }[] };
}

const PROMETHEUS_URL =
    process.env.PROMETHEUS_URL ??
    'http://kube-prometheus-stack-prometheus.kleinkram-observability.svc:9090';

/**
 * kube-prometheus-stack scrapes cAdvisor cluster-wide, so just need to
 * read its data for usage metrics
 */
@Injectable()
export class ResourceUsageService {
    constructor(
        @InjectRepository(ActionEntity)
        private actionRepository: Repository<ActionEntity>,
    ) {}

    async recordUsage(
        actionUuid: string,
        memoryLimitBytes: number,
        start: Date,
        end: Date,
    ): Promise<void> {
        try {
            const usage = await this.queryUsage(actionUuid, start, end);
            if (!usage) return;

            const efficiencyScore =
                memoryLimitBytes > 0
                    ? usage.maxMemoryBytes / memoryLimitBytes
                    : 0;

            await this.actionRepository.update(
                { uuid: actionUuid },
                {
                    resourceUsage: usage,
                    maxMemoryBytes: usage.maxMemoryBytes,
                    avgCpuPercent: usage.avgCpuPercent,
                    efficiencyScore,
                },
            );
        } catch (error) {
            logger.warn(
                `Failed to record resource usage for action ${actionUuid} from Prometheus: ${String(error)}`,
            );
        }
    }

    private async queryUsage(
        actionUuid: string,
        start: Date,
        end: Date,
    ): Promise<ResourceUsage | null> {
        const step = '15s';
        const podSelector = `pod=~"${actionUuid}.*"`;

        const [memorySeries, cpuSeries] = await Promise.all([
            this.rangeQuery(
                `max(container_memory_working_set_bytes{${podSelector}, container!="", container!="POD"})`,
                start,
                end,
                step,
            ),
            this.rangeQuery(
                `sum(rate(container_cpu_usage_seconds_total{${podSelector}, container!="", container!="POD"}[1m])) * 100`,
                start,
                end,
                step,
            ),
        ]);

        if (memorySeries.length === 0 && cpuSeries.length === 0) return null;

        const memoryValues = memorySeries.map(([, v]) => Number.parseFloat(v));
        const cpuValues = cpuSeries.map(([, v]) => Number.parseFloat(v));

        const maxMemoryBytes = memoryValues.length
            ? Math.max(...memoryValues)
            : 0;
        const maxCpuPercent = cpuValues.length ? Math.max(...cpuValues) : 0;
        const avgCpuPercent = cpuValues.length
            ? cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length
            : 0;

        return {
            maxMemoryBytes,
            maxCpuPercent,
            avgCpuPercent,
            samples: memorySeries.map(([timestamp, value], index) => ({
                t: Math.round(timestamp - start.getTime() / 1000),
                m: Number.parseFloat(value),
                c: cpuValues[index] ?? 0,
            })),
        };
    }

    private async rangeQuery(
        query: string,
        start: Date,
        end: Date,
        step: string,
    ): Promise<[number, string][]> {
        try {
            const response = await axios.get<PrometheusRangeResponse>(
                `${PROMETHEUS_URL}/api/v1/query_range`,
                {
                    params: {
                        query,
                        start: (start.getTime() / 1000).toString(),
                        end: (end.getTime() / 1000).toString(),
                        step,
                    },
                    timeout: 5000,
                },
            );
            return response.data.data.result[0]?.values ?? [];
        } catch (error) {
            logger.debug(
                `Prometheus range query failed (${query}): ${String(error)}`,
            );
            return [];
        }
    }
}
