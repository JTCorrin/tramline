import type {
	Alert,
	MetricRange,
	NodeMetrics,
	SecurityEvent,
	ServiceMetrics
} from '@tramline/contracts';
import type { Http } from '../http';

export const metrics = (http: Http) => ({
	/** A service's CPU, memory and network in an environment, summed over its replicas. */
	service: (serviceId: string, environmentId: string, range: MetricRange = '1h') =>
		http.get<ServiceMetrics>(`/services/${serviceId}/metrics`, { environmentId, range }),
	node: (nodeId: string, range: MetricRange = '1h') =>
		http.get<NodeMetrics>(`/nodes/${nodeId}/metrics`, { range }),
	/** What the service's containers tried that containment blocked, over the last week. */
	security: (serviceId: string, environmentId: string) =>
		http.get<SecurityEvent[]>(`/services/${serviceId}/security`, { environmentId }),
	/** Open alerts, and those resolved in the last day. */
	alerts: () => http.get<Alert[]>('/alerts')
});
