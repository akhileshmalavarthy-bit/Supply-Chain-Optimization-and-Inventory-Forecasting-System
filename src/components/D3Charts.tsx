import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';

function useContainerSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ width: 520, height: 260 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 20 && rect.height > 20) {
        setSize({ width: rect.width, height: rect.height });
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/**
 * 1. D3 Inventory Distribution Donut Chart
 */
export const D3InventoryDonut: React.FC<{
  counts: [number, number, number, number]; // [Healthy, Low stock, Out of stock, Potential excess]
}> = ({ counts }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const { width, height } = useContainerSize(containerRef);
  const [hovered, setHovered] = useState<{ label: string; value: number; color: string } | null>(null);

  const labels = ['Healthy', 'Low stock', 'Out of stock', 'Potential excess'];
  const colors = ['#22c55e', '#f59e0b', '#e11d2e', '#6b7280'];
  const total = counts.reduce((a, b) => a + b, 0);

  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const legendHeight = 36;
    const chartH = Math.max(140, height - legendHeight);
    const radius = Math.min(width, chartH) / 2 - 12;
    const innerRadius = radius * 0.62;

    const g = svg
      .append('g')
      .attr('transform', `translate(${width / 2},${chartH / 2})`);

    const data = labels.map((label, i) => ({
      label,
      value: counts[i],
      color: colors[i],
    }));

    const pie = d3
      .pie<{ label: string; value: number; color: string }>()
      .value((d) => d.value)
      .sort(null)
      .padAngle(0.025);

    const arc = d3
      .arc<d3.PieArcDatum<{ label: string; value: number; color: string }>>()
      .innerRadius(innerRadius)
      .outerRadius(radius)
      .cornerRadius(4);

    const arcHover = d3
      .arc<d3.PieArcDatum<{ label: string; value: number; color: string }>>()
      .innerRadius(innerRadius)
      .outerRadius(radius + 6)
      .cornerRadius(4);

    const arcs = g
      .selectAll('.arc')
      .data(pie(data))
      .enter()
      .append('g')
      .attr('class', 'arc');

    arcs
      .append('path')
      .attr('d', arc)
      .attr('fill', (d) => d.data.color)
      .attr('stroke', '#141414')
      .attr('stroke-width', 2)
      .style('cursor', 'pointer')
      .on('mouseenter', function (_event, d) {
        d3.select(this).transition().duration(140).attr('d', arcHover as never);
        setHovered(d.data);
      })
      .on('mouseleave', function () {
        d3.select(this).transition().duration(140).attr('d', arc as never);
        setHovered(null);
      });
  }, [counts, width, height]);

  return (
    <div ref={containerRef} className="relative w-full h-[260px] select-none">
      <svg ref={svgRef} width={width} height={height} className="overflow-visible" />
      <div
        className="pointer-events-none absolute inset-x-0 flex flex-col items-center justify-center"
        style={{ top: 0, height: Math.max(140, height - 36) }}
      >
        <span className="font-mono text-2xl font-bold text-[#f2f2f2] tabular-nums">
          {hovered ? hovered.value : total}
        </span>
        <span className="text-xs text-[#9b9b9b]">
          {hovered ? hovered.label : 'Total SKUs'}
        </span>
      </div>
      <div className="absolute bottom-1 inset-x-0 flex flex-wrap items-center justify-center gap-4 text-xs text-[#b5b5b5]">
        {labels.map((lbl, idx) => (
          <div key={lbl} className="flex items-center gap-1.5">
            <span
              className="inline-block w-2.5 h-2.5 rounded-xs"
              style={{ backgroundColor: colors[idx] }}
            />
            <span>{lbl}</span>
            <span className="font-mono text-[#f2f2f2] tabular-nums">({counts[idx]})</span>
          </div>
        ))}
      </div>
    </div>
  );
};

/**
 * 2. D3 Demand Analysis Chart (Daily Line/Area or Monthly Bar)
 */
export const D3DemandChart: React.FC<{
  labels: string[];
  values: number[];
  mode: 'd' | 'm';
}> = ({ labels, values, mode }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const { width, height } = useContainerSize(containerRef);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; label: string; value: number } | null>(null);

  useEffect(() => {
    if (!svgRef.current || labels.length === 0) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const margin = { top: 14, right: 16, bottom: 32, left: 44 };
    const innerW = Math.max(100, width - margin.left - margin.right);
    const innerH = Math.max(80, height - margin.top - margin.bottom);

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    const yMax = Math.max(10, d3.max(values) || 10) * 1.12;
    const y = d3.scaleLinear().domain([0, yMax]).nice().range([innerH, 0]);

    // Horizontal grid lines
    g.append('g')
      .attr('class', 'grid')
      .call(
        d3
          .axisLeft(y)
          .ticks(5)
          .tickSize(-innerW)
          .tickFormat(() => '')
      )
      .call((gEl) => {
        gEl.select('.domain').remove();
        gEl.selectAll('line').attr('stroke', '#222222').attr('stroke-dasharray', '3,3');
      });

    // Y Axis
    g.append('g')
      .call(d3.axisLeft(y).ticks(5))
      .call((gEl) => {
        gEl.select('.domain').attr('stroke', '#2b2b2b');
        gEl.selectAll('line').attr('stroke', '#2b2b2b');
        gEl.selectAll('text').attr('fill', '#9b9b9b').style('font-family', 'JetBrains Mono, monospace').style('font-size', '11px');
      });

    if (mode === 'm') {
      const x = d3.scaleBand().domain(labels).range([0, innerW]).padding(0.32);

      g.append('g')
        .attr('transform', `translate(0,${innerH})`)
        .call(d3.axisBottom(x))
        .call((gEl) => {
          gEl.select('.domain').attr('stroke', '#2b2b2b');
          gEl.selectAll('line').attr('stroke', '#2b2b2b');
          gEl.selectAll('text').attr('fill', '#9b9b9b').style('font-family', 'JetBrains Mono, monospace').style('font-size', '11px');
        });

      g.selectAll('.bar')
        .data(labels.map((l, i) => ({ label: l, value: values[i] })))
        .enter()
        .append('rect')
        .attr('x', (d) => x(d.label) || 0)
        .attr('y', (d) => y(d.value))
        .attr('width', x.bandwidth())
        .attr('height', (d) => innerH - y(d.value))
        .attr('fill', '#e11d2e')
        .attr('rx', 3)
        .style('cursor', 'pointer')
        .on('mouseenter', (_event, d) => {
          setTooltip({
            x: (x(d.label) || 0) + x.bandwidth() / 2 + margin.left,
            y: y(d.value) + margin.top,
            label: d.label,
            value: d.value,
          });
        })
        .on('mouseleave', () => setTooltip(null));
    } else {
      const x = d3
        .scaleLinear()
        .domain([0, Math.max(1, labels.length - 1)])
        .range([0, innerW]);

      const tickIndices = d3.range(0, labels.length, Math.max(1, Math.floor(labels.length / 7)));
      g.append('g')
        .attr('transform', `translate(0,${innerH})`)
        .call(
          d3
            .axisBottom(x)
            .tickValues(tickIndices)
            .tickFormat((d) => labels[Number(d)]?.slice(5) || '')
        )
        .call((gEl) => {
          gEl.select('.domain').attr('stroke', '#2b2b2b');
          gEl.selectAll('line').attr('stroke', '#2b2b2b');
          gEl.selectAll('text').attr('fill', '#9b9b9b').style('font-family', 'JetBrains Mono, monospace').style('font-size', '11px');
        });

      const area = d3
        .area<number>()
        .x((_d, i) => x(i))
        .y0(innerH)
        .y1((d) => y(d))
        .curve(d3.curveMonotoneX);

      const line = d3
        .line<number>()
        .x((_d, i) => x(i))
        .y((d) => y(d))
        .curve(d3.curveMonotoneX);

      g.append('path')
        .datum(values)
        .attr('fill', 'rgba(225, 29, 46, 0.18)')
        .attr('d', area);

      g.append('path')
        .datum(values)
        .attr('fill', 'none')
        .attr('stroke', '#e11d2e')
        .attr('stroke-width', 2)
        .attr('d', line);

      // Interactive overlay for daily scrubbing
      g.append('rect')
        .attr('width', innerW)
        .attr('height', innerH)
        .attr('fill', 'transparent')
        .style('cursor', 'crosshair')
        .on('mousemove', (event) => {
          const [mx] = d3.pointer(event);
          const idx = Math.min(
            labels.length - 1,
            Math.max(0, Math.round(x.invert(mx)))
          );
          setTooltip({
            x: x(idx) + margin.left,
            y: y(values[idx]) + margin.top,
            label: labels[idx],
            value: values[idx],
          });
        })
        .on('mouseleave', () => setTooltip(null));
    }
  }, [labels, values, mode, width, height]);

  return (
    <div ref={containerRef} className="relative w-full h-[260px] select-none">
      <svg ref={svgRef} width={width} height={height} />
      {tooltip && (
        <div
          className="pointer-events-none absolute z-10 bg-[#0d0d0d] border border-[#2b2b2b] rounded-md px-2.5 py-1.5 text-xs shadow-lg"
          style={{
            left: Math.min(width - 130, Math.max(8, tooltip.x - 50)),
            top: Math.max(4, tooltip.y - 42),
          }}
        >
          <div className="text-[#9b9b9b] font-mono">{tooltip.label}</div>
          <div className="text-[#f2f2f2] font-mono font-semibold tabular-nums">
            {tooltip.value.toLocaleString()} units
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * 3. D3 Supplier On-Time Delivery % Bar Chart
 */
export const D3SupplierBarChart: React.FC<{
  suppliers: { name: string; onTimePct: number }[];
}> = ({ suppliers }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const { width, height } = useContainerSize(containerRef);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; name: string; pct: number } | null>(null);

  useEffect(() => {
    if (!svgRef.current || suppliers.length === 0) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const margin = { top: 14, right: 16, bottom: 32, left: 40 };
    const innerW = Math.max(100, width - margin.left - margin.right);
    const innerH = Math.max(80, height - margin.top - margin.bottom);

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    const labels = suppliers.map((s) => s.name.split(' ')[0]);
    const x = d3.scaleBand().domain(labels).range([0, innerW]).padding(0.35);
    const y = d3.scaleLinear().domain([0, 100]).range([innerH, 0]);

    g.append('g')
      .call(
        d3
          .axisLeft(y)
          .ticks(5)
          .tickSize(-innerW)
          .tickFormat(() => '')
      )
      .call((gEl) => {
        gEl.select('.domain').remove();
        gEl.selectAll('line').attr('stroke', '#222222').attr('stroke-dasharray', '3,3');
      });

    g.append('g')
      .call(d3.axisLeft(y).ticks(5).tickFormat((d) => `${d}%`))
      .call((gEl) => {
        gEl.select('.domain').attr('stroke', '#2b2b2b');
        gEl.selectAll('line').attr('stroke', '#2b2b2b');
        gEl.selectAll('text').attr('fill', '#9b9b9b').style('font-family', 'JetBrains Mono, monospace').style('font-size', '11px');
      });

    g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(x))
      .call((gEl) => {
        gEl.select('.domain').attr('stroke', '#2b2b2b');
        gEl.selectAll('line').attr('stroke', '#2b2b2b');
        gEl.selectAll('text').attr('fill', '#9b9b9b').style('font-size', '11px');
      });

    g.selectAll('.bar')
      .data(suppliers)
      .enter()
      .append('rect')
      .attr('x', (d) => x(d.name.split(' ')[0]) || 0)
      .attr('y', (d) => y(d.onTimePct))
      .attr('width', x.bandwidth())
      .attr('height', (d) => innerH - y(d.onTimePct))
      .attr('fill', '#e11d2e')
      .attr('rx', 3)
      .style('cursor', 'pointer')
      .on('mouseenter', (_e, d) => {
        const short = d.name.split(' ')[0];
        setTooltip({
          x: (x(short) || 0) + x.bandwidth() / 2 + margin.left,
          y: y(d.onTimePct) + margin.top,
          name: d.name,
          pct: d.onTimePct,
        });
      })
      .on('mouseleave', () => setTooltip(null));
  }, [suppliers, width, height]);

  return (
    <div ref={containerRef} className="relative w-full h-[260px] select-none">
      <svg ref={svgRef} width={width} height={height} />
      {tooltip && (
        <div
          className="pointer-events-none absolute z-10 bg-[#0d0d0d] border border-[#2b2b2b] rounded-md px-2.5 py-1.5 text-xs shadow-lg"
          style={{
            left: Math.min(width - 150, Math.max(8, tooltip.x - 60)),
            top: Math.max(4, tooltip.y - 42),
          }}
        >
          <div className="text-[#9b9b9b]">{tooltip.name}</div>
          <div className="text-[#f2f2f2] font-mono font-semibold tabular-nums">
            On-time: {tooltip.pct}%
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * 4. D3 Stock vs Reorder Point Grouped Logarithmic Bar Chart
 */
export const D3StockVsRopChart: React.FC<{
  items: { name: string; stock: number; rop: number }[];
}> = ({ items }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const { width, height } = useContainerSize(containerRef);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; name: string; stock: number; rop: number } | null>(null);

  useEffect(() => {
    if (!svgRef.current || items.length === 0) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const margin = { top: 24, right: 16, bottom: 42, left: 46 };
    const innerW = Math.max(100, width - margin.left - margin.right);
    const innerH = Math.max(80, height - margin.top - margin.bottom);

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    const names = items.map((d) => d.name);
    const x0 = d3.scaleBand().domain(names).range([0, innerW]).padding(0.25);
    const x1 = d3.scaleBand().domain(['stock', 'rop']).range([0, x0.bandwidth()]).padding(0.08);

    const maxVal = Math.max(100, d3.max(items, (d) => Math.max(d.stock, d.rop)) || 100);
    // Log scale (clamped to >= 1 for logarithmic rendering)
    const y = d3.scaleLog().domain([1, maxVal * 1.3]).range([innerH, 0]).clamp(true);

    g.append('g')
      .call(
        d3
          .axisLeft(y)
          .ticks(4, '~s')
          .tickSize(-innerW)
          .tickFormat(() => '')
      )
      .call((gEl) => {
        gEl.select('.domain').remove();
        gEl.selectAll('line').attr('stroke', '#222222').attr('stroke-dasharray', '3,3');
      });

    g.append('g')
      .call(d3.axisLeft(y).ticks(4, '~s'))
      .call((gEl) => {
        gEl.select('.domain').attr('stroke', '#2b2b2b');
        gEl.selectAll('line').attr('stroke', '#2b2b2b');
        gEl.selectAll('text').attr('fill', '#9b9b9b').style('font-family', 'JetBrains Mono, monospace').style('font-size', '10px');
      });

    g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(x0))
      .call((gEl) => {
        gEl.select('.domain').attr('stroke', '#2b2b2b');
        gEl.selectAll('line').attr('stroke', '#2b2b2b');
        gEl
          .selectAll('text')
          .attr('fill', '#9b9b9b')
          .style('font-size', '10px')
          .attr('transform', 'rotate(-20)')
          .style('text-anchor', 'end');
      });

    const groups = g
      .selectAll('.grp')
      .data(items)
      .enter()
      .append('g')
      .attr('transform', (d) => `translate(${x0(d.name) || 0},0)`)
      .style('cursor', 'pointer')
      .on('mouseenter', (_e, d) => {
        setTooltip({
          x: (x0(d.name) || 0) + x0.bandwidth() / 2 + margin.left,
          y: y(Math.max(1, d.stock, d.rop)) + margin.top,
          name: d.name,
          stock: d.stock,
          rop: d.rop,
        });
      })
      .on('mouseleave', () => setTooltip(null));

    groups
      .append('rect')
      .attr('x', x1('stock') || 0)
      .attr('y', (d) => (d.stock <= 0 ? innerH - 3 : y(Math.max(1, d.stock))))
      .attr('width', x1.bandwidth())
      .attr('height', (d) => (d.stock <= 0 ? 3 : innerH - y(Math.max(1, d.stock))))
      .attr('fill', '#e11d2e')
      .attr('rx', 2);

    groups
      .append('rect')
      .attr('x', x1('rop') || 0)
      .attr('y', (d) => y(Math.max(1, d.rop)))
      .attr('width', x1.bandwidth())
      .attr('height', (d) => innerH - y(Math.max(1, d.rop)))
      .attr('fill', '#6b7280')
      .attr('rx', 2);
  }, [items, width, height]);

  return (
    <div ref={containerRef} className="relative w-full h-[260px] select-none">
      <div className="absolute top-0 right-2 flex items-center gap-4 text-xs text-[#b5b5b5]">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 bg-[#e11d2e] inline-block rounded-xs" /> Current stock
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 bg-[#6b7280] inline-block rounded-xs" /> Reorder point
        </span>
      </div>
      <svg ref={svgRef} width={width} height={height} />
      {tooltip && (
        <div
          className="pointer-events-none absolute z-10 bg-[#0d0d0d] border border-[#2b2b2b] rounded-md px-2.5 py-1.5 text-xs shadow-lg"
          style={{
            left: Math.min(width - 150, Math.max(8, tooltip.x - 60)),
            top: Math.max(4, tooltip.y - 48),
          }}
        >
          <div className="font-semibold text-[#f2f2f2]">{tooltip.name}</div>
          <div className="font-mono text-[#ff5560] tabular-nums">Stock: {tooltip.stock}</div>
          <div className="font-mono text-[#9b9b9b] tabular-nums">ROP: {tooltip.rop}</div>
        </div>
      )}
    </div>
  );
};

/**
 * 5. D3 Inventory Value Horizontal Bar Chart
 */
export const D3InventoryValueChart: React.FC<{
  items: { name: string; value: number }[];
  currencySymbol?: string;
  currencyLocale?: string;
}> = ({ items, currencySymbol = '₹', currencyLocale = 'en-IN' }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const { width, height } = useContainerSize(containerRef);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; name: string; value: number } | null>(null);

  useEffect(() => {
    if (!svgRef.current || items.length === 0) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const margin = { top: 10, right: 20, bottom: 26, left: 92 };
    const innerW = Math.max(100, width - margin.left - margin.right);
    const innerH = Math.max(80, height - margin.top - margin.bottom);

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    const maxV = Math.max(1000, d3.max(items, (d) => d.value) || 1000) * 1.08;
    const x = d3.scaleLinear().domain([0, maxV]).range([0, innerW]);
    const y = d3
      .scaleBand()
      .domain(items.map((d) => d.name))
      .range([0, innerH])
      .padding(0.25);

    g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(4, '~s'))
      .call((gEl) => {
        gEl.select('.domain').attr('stroke', '#2b2b2b');
        gEl.selectAll('line').attr('stroke', '#2b2b2b');
        gEl.selectAll('text').attr('fill', '#9b9b9b').style('font-family', 'JetBrains Mono, monospace').style('font-size', '10px');
      });

    g.append('g')
      .call(d3.axisLeft(y))
      .call((gEl) => {
        gEl.select('.domain').attr('stroke', '#2b2b2b');
        gEl.selectAll('line').attr('stroke', '#2b2b2b');
        gEl.selectAll('text').attr('fill', '#b5b5b5').style('font-size', '11px');
      });

    g.selectAll('.hbar')
      .data(items)
      .enter()
      .append('rect')
      .attr('x', 0)
      .attr('y', (d) => y(d.name) || 0)
      .attr('width', (d) => Math.max(2, x(d.value)))
      .attr('height', y.bandwidth())
      .attr('fill', '#e11d2e')
      .attr('rx', 2)
      .style('cursor', 'pointer')
      .on('mouseenter', (_e, d) => {
        setTooltip({
          x: x(d.value) + margin.left,
          y: (y(d.name) || 0) + margin.top,
          name: d.name,
          value: d.value,
        });
      })
      .on('mouseleave', () => setTooltip(null));
  }, [items, width, height]);

  return (
    <div ref={containerRef} className="relative w-full h-[260px] select-none">
      <svg ref={svgRef} width={width} height={height} />
      {tooltip && (
        <div
          className="pointer-events-none absolute z-10 bg-[#0d0d0d] border border-[#2b2b2b] rounded-md px-2.5 py-1.5 text-xs shadow-lg"
          style={{
            left: Math.min(width - 160, Math.max(8, tooltip.x - 40)),
            top: Math.max(4, tooltip.y - 28),
          }}
        >
          <div className="text-[#9b9b9b]">{tooltip.name}</div>
          <div className="font-mono font-semibold text-[#f2f2f2] tabular-nums">
            {currencySymbol}
            {Math.round(tooltip.value).toLocaleString(currencyLocale)}
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * 6. D3 Demand Forecast Line Chart (60d Historical + 14d Baseline Forecast)
 */
export const D3ForecastChart: React.FC<{
  histDates: string[];
  histValues: number[];
  forecastDates: string[];
  forecastValue: number;
}> = ({ histDates, histValues, forecastDates, forecastValue }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const { width, height } = useContainerSize(containerRef);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; date: string; val: number; isForecast: boolean } | null>(null);

  useEffect(() => {
    if (!svgRef.current || histDates.length === 0) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const margin = { top: 24, right: 18, bottom: 30, left: 44 };
    const innerW = Math.max(100, width - margin.left - margin.right);
    const innerH = Math.max(80, height - margin.top - margin.bottom);

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    const allDates = [...histDates, ...forecastDates];
    const maxY = Math.max(10, d3.max(histValues) || 10, forecastValue) * 1.18;

    const x = d3
      .scaleLinear()
      .domain([0, allDates.length - 1])
      .range([0, innerW]);
    const y = d3.scaleLinear().domain([0, maxY]).nice().range([innerH, 0]);

    g.append('g')
      .call(
        d3
          .axisLeft(y)
          .ticks(5)
          .tickSize(-innerW)
          .tickFormat(() => '')
      )
      .call((gEl) => {
        gEl.select('.domain').remove();
        gEl.selectAll('line').attr('stroke', '#222222').attr('stroke-dasharray', '3,3');
      });

    g.append('g')
      .call(d3.axisLeft(y).ticks(5))
      .call((gEl) => {
        gEl.select('.domain').attr('stroke', '#2b2b2b');
        gEl.selectAll('line').attr('stroke', '#2b2b2b');
        gEl.selectAll('text').attr('fill', '#9b9b9b').style('font-family', 'JetBrains Mono, monospace').style('font-size', '11px');
      });

    const tickIndices = d3.range(0, allDates.length, Math.max(1, Math.floor(allDates.length / 7)));
    g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(
        d3
          .axisBottom(x)
          .tickValues(tickIndices)
          .tickFormat((d) => allDates[Number(d)]?.slice(5) || '')
      )
      .call((gEl) => {
        gEl.select('.domain').attr('stroke', '#2b2b2b');
        gEl.selectAll('line').attr('stroke', '#2b2b2b');
        gEl.selectAll('text').attr('fill', '#9b9b9b').style('font-family', 'JetBrains Mono, monospace').style('font-size', '11px');
      });

    // Forecast zone shading
    const splitX = x(histDates.length - 1);
    g.append('rect')
      .attr('x', splitX)
      .attr('y', 0)
      .attr('width', Math.max(0, innerW - splitX))
      .attr('height', innerH)
      .attr('fill', 'rgba(255,255,255,0.025)');

    // Historical line
    const histLine = d3
      .line<number>()
      .x((_d, i) => x(i))
      .y((d) => y(d))
      .curve(d3.curveMonotoneX);

    g.append('path')
      .datum(histValues)
      .attr('fill', 'none')
      .attr('stroke', '#e11d2e')
      .attr('stroke-width', 2)
      .attr('d', histLine);

    // Forecast dashed line starting from last historical point
    const fcPoints: { idx: number; val: number }[] = [
      { idx: histDates.length - 1, val: histValues[histValues.length - 1] ?? forecastValue },
      ...forecastDates.map((_d, j) => ({
        idx: histDates.length + j,
        val: Number(forecastValue.toFixed(1)),
      })),
    ];

    const fcLine = d3
      .line<{ idx: number; val: number }>()
      .x((d) => x(d.idx))
      .y((d) => y(d.val));

    g.append('path')
      .datum(fcPoints)
      .attr('fill', 'none')
      .attr('stroke', '#f2f2f2')
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '6,4')
      .attr('d', fcLine);

    g.append('rect')
      .attr('width', innerW)
      .attr('height', innerH)
      .attr('fill', 'transparent')
      .style('cursor', 'crosshair')
      .on('mousemove', (event) => {
        const [mx] = d3.pointer(event);
        const idx = Math.min(allDates.length - 1, Math.max(0, Math.round(x.invert(mx))));
        const isFc = idx >= histDates.length;
        const val = isFc ? Number(forecastValue.toFixed(1)) : histValues[idx];
        setTooltip({
          x: x(idx) + margin.left,
          y: y(val) + margin.top,
          date: allDates[idx],
          val,
          isForecast: isFc,
        });
      })
      .on('mouseleave', () => setTooltip(null));
  }, [histDates, histValues, forecastDates, forecastValue, width, height]);

  return (
    <div ref={containerRef} className="relative w-full h-[260px] select-none">
      <div className="absolute top-0 right-2 flex items-center gap-4 text-xs text-[#b5b5b5]">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-0.5 bg-[#e11d2e] inline-block" /> Historical demand
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-0.5 border-t-2 border-dashed border-[#f2f2f2] inline-block" /> Baseline forecast (next 14d)
        </span>
      </div>
      <svg ref={svgRef} width={width} height={height} />
      {tooltip && (
        <div
          className="pointer-events-none absolute z-10 bg-[#0d0d0d] border border-[#2b2b2b] rounded-md px-2.5 py-1.5 text-xs shadow-lg"
          style={{
            left: Math.min(width - 160, Math.max(8, tooltip.x - 60)),
            top: Math.max(4, tooltip.y - 45),
          }}
        >
          <div className="text-[#9b9b9b] font-mono">
            {tooltip.date} · {tooltip.isForecast ? 'Forecast' : 'Historical'}
          </div>
          <div className="font-mono font-semibold text-[#f2f2f2] tabular-nums">
            {tooltip.val} units/day
          </div>
        </div>
      )}
    </div>
  );
};
