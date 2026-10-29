import type { Alert, MetricRange, NodeMetrics, ServiceMetrics } from '@tramline/contracts';
import type { Http } from '../http';

export const metrics = (http: Http) => ({
	/** A service's CPU, memory and network in an environment, summed over its replicas. */
	service: (serviceId: string, environmentId: string, range: MetricRange = '1h') =>
		http.get<ServiceMetrics>(`/services/${serviceId}/metrics`, { environmentId, range }),
	node: (nodeId: string, range: MetricRange = '1h') =>
		http.get<NodeMetrics>(`/nodes/${nodeId}/metrics`, { range }),
	/** Open alerts, and those resolved in the last day. */
	alerts: () => http.get<Alert[]>('/alerts')
});
