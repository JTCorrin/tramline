<script lang="ts" module>
	export interface Series {
		label: string;
		/** A CSS colour, e.g. `var(--series-1)`. */
		color: string;
	}

	export interface ChartPoint {
		/** Epoch milliseconds. */
		at: number;
		/** One value per series; null leaves a gap. */
		values: (number | null)[];
	}
</script>

<script lang="ts">
	let {
		label,
		series,
		points,
		step,
		format,
		from,
		to,
		limit = null,
		max = null
	}: {
		/** Names the chart for screen readers. */
		label: string;
		series: Series[];
		points: ChartPoint[];
		/** Seconds between points; a longer gap breaks the line. */
		step: number;
		format: (value: number) => string;
		/** The time range shown, in epoch milliseconds. */
		from: number;
		to: number;
		/** A ceiling to draw, e.g. a memory limit. */
		limit?: { value: number; label: string } | null;
		/** The top of the scale, e.g. 100 for a percentage; otherwise it fits the data. */
		max?: number | null;
	} = $props();

	const HEIGHT = 140;
	const PAD = { top: 12, right: 12, bottom: 22, left: 52 };

	let width = $state(480);
	let active = $state<number | null>(null);

	const plotWidth = $derived(Math.max(1, width - PAD.left - PAD.right));
	const plotHeight = HEIGHT - PAD.top - PAD.bottom;

	const top = $derived.by(() => {
		if (max !== null) return max;
		const highest = Math.max(
			0,
			limit?.value ?? 0,
			...points.flatMap((p) => p.values.filter((v): v is number => v !== null))
		);
		return niceCeiling(highest);
	});
	const ticks = $derived([0, top / 2, top]);

	const x = (at: number) => PAD.left + ((at - from) / Math.max(1, to - from)) * plotWidth;
	const y = (value: number) =>
		PAD.top + plotHeight - (Math.min(value, top) / (top || 1)) * plotHeight;

	/** One path per series, broken where a point is missing or the next comes too late. */
	const paths = $derived(
		series.map((_, i) => {
			let d = '';
			let previous: number | null = null;
			for (const point of points) {
				const value = point.values[i];
				if (value === null || value === undefined) {
					previous = null;
					continue;
				}
				const joined = previous !== null && point.at - previous <= step * 1500;
				d += `${joined ? 'L' : 'M'}${x(point.at).toFixed(1)},${y(value).toFixed(1)}`;
				previous = point.at;
			}
			return d;
		})
	);

	const timeFormat = $derived(
		to - from > 2 * 86_400_000
			? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
			: new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
	);
	const tooltipTime = new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});

	function niceCeiling(value: number) {
		if (value <= 0) return 1;
		const magnitude = 10 ** Math.floor(Math.log10(value));
		const scaled = value / magnitude;
		const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
		return nice * magnitude;
	}

	function nearest(clientX: number, rect: DOMRect) {
		if (!points.length) return null;
		const at = from + ((clientX - rect.left - PAD.left) / plotWidth) * (to - from);
		let best = 0;
		for (let i = 1; i < points.length; i++) {
			if (Math.abs(points[i]!.at - at) < Math.abs(points[best]!.at - at)) best = i;
		}
		return best;
	}

	function onkeydown(event: KeyboardEvent) {
		if (!points.length) return;
		if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
			event.preventDefault();
			const delta = event.key === 'ArrowLeft' ? -1 : 1;
			active = Math.min(points.length - 1, Math.max(0, (active ?? points.length - 1) + delta));
		} else if (event.key === 'Escape') {
			active = null;
		}
	}

	const shown = $derived(active === null ? null : points[active]);
	const latest = $derived(points.at(-1));

	/** A point in words, for screen readers. */
	function describe(point: ChartPoint | undefined) {
		if (!point) return 'No data';
		const values = series.map(
			(s, i) => `${s.label} ${point.values[i] === null ? 'no data' : format(point.values[i]!)}`
		);
		return `${tooltipTime.format(point.at)}: ${values.join(', ')}`;
	}
</script>

<div class="relative" bind:clientWidth={width}>
	{#if series.length > 1}
		<ul class="mb-1 flex gap-4 text-xs text-muted-foreground">
			{#each series as s (s.label)}
				<li class="flex items-center gap-1.5">
					<span class="inline-block h-0.5 w-3 rounded" style:background={s.color}></span>
					{s.label}
				</li>
			{/each}
		</ul>
	{/if}
	<svg
		role="slider"
		aria-label="{label}: use the arrow keys to move through time"
		aria-valuemin={0}
		aria-valuemax={Math.max(0, points.length - 1)}
		aria-valuenow={active ?? Math.max(0, points.length - 1)}
		aria-valuetext={describe(shown ?? latest)}
		tabindex="0"
		width="100%"
		height={HEIGHT}
		viewBox="0 0 {width} {HEIGHT}"
		class="block overflow-visible outline-none focus-visible:ring-2 focus-visible:ring-ring"
		onpointermove={(event) =>
			(active = nearest(event.clientX, event.currentTarget.getBoundingClientRect()))}
		onpointerleave={() => (active = null)}
		onblur={() => (active = null)}
		{onkeydown}
	>
		{#each ticks as tick (tick)}
			<line
				x1={PAD.left}
				x2={PAD.left + plotWidth}
				y1={y(tick)}
				y2={y(tick)}
				class="stroke-border"
				stroke-width="1"
			/>
			<text
				x={PAD.left - 6}
				y={y(tick)}
				text-anchor="end"
				dominant-baseline="middle"
				class="fill-muted-foreground text-[10px]">{format(tick)}</text
			>
		{/each}
		<text x={PAD.left} y={HEIGHT - 4} class="fill-muted-foreground text-[10px]"
			>{timeFormat.format(from)}</text
		>
		<text
			x={PAD.left + plotWidth}
			y={HEIGHT - 4}
			text-anchor="end"
			class="fill-muted-foreground text-[10px]">{timeFormat.format(to)}</text
		>

		{#if limit}
			<line
				x1={PAD.left}
				x2={PAD.left + plotWidth}
				y1={y(limit.value)}
				y2={y(limit.value)}
				class="stroke-muted-foreground"
				stroke-width="1"
			/>
			<text
				x={PAD.left + plotWidth}
				y={y(limit.value) - 4}
				text-anchor="end"
				class="fill-muted-foreground text-[10px]">{limit.label}</text
			>
		{/if}

		{#each paths as d, i (series[i]!.label)}
			<path
				{d}
				fill="none"
				stroke={series[i]!.color}
				stroke-width="2"
				stroke-linejoin="round"
				stroke-linecap="round"
			/>
		{/each}

		{#if shown}
			<line
				x1={x(shown.at)}
				x2={x(shown.at)}
				y1={PAD.top}
				y2={PAD.top + plotHeight}
				class="stroke-muted-foreground"
				stroke-width="1"
			/>
			{#each shown.values as value, i (i)}
				{#if value !== null}
					<circle
						cx={x(shown.at)}
						cy={y(value)}
						r="4"
						fill={series[i]!.color}
						class="stroke-card"
						stroke-width="2"
					/>
				{/if}
			{/each}
		{/if}
	</svg>

	{#if shown}
		<!-- the slider's value text says the same for screen readers -->
		<div
			aria-hidden="true"
			class="pointer-events-none absolute top-0 rounded-md border bg-popover px-2 py-1.5 text-xs shadow-sm"
			style:left="{Math.min(x(shown.at) + 8, width - 150)}px"
		>
			<div class="text-muted-foreground">{tooltipTime.format(shown.at)}</div>
			{#each series as s, i (s.label)}
				<div class="flex items-center gap-1.5">
					<span class="inline-block h-0.5 w-3 rounded" style:background={s.color}></span>
					<span class="font-medium text-foreground"
						>{shown.values[i] === null ? '—' : format(shown.values[i]!)}</span
					>
					<span class="text-muted-foreground">{s.label}</span>
				</div>
			{/each}
		</div>
	{/if}
</div>
