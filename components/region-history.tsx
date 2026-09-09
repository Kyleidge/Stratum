'use client';
import { useEffect, useRef, useState } from 'react';
import { Scissors, Sigma, Table2, LockKeyhole } from 'lucide-react';
import { operationLabels } from '@/lib/signal-explorer';
import type { HistoryItem } from '@/lib/region-model';
import type { SignalNode } from '@/lib/signal-types';

export default function RegionHistory({
  items,
  selectedId,
  onSelect,
  raw,
  onRaw,
}: {
  items: HistoryItem[];
  selectedId: string;
  onSelect: (item: HistoryItem) => void;
  raw: SignalNode[];
  onRaw: (id: string) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0),
    [height, setHeight] = useState(500);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setHeight(entry.contentRect.height),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const index = items.findIndex((item) => item.id === selectedId);
    if (index >= 0)
      viewport.current?.scrollTo({ top: Math.max(0, index * 58 - height / 3) });
  }, [selectedId, items, height]);
  const start = Math.min(
      Math.max(0, items.length - 1),
      Math.max(0, Math.floor(top / 58) - 4),
    ),
    visible = items.slice(start, start + Math.ceil(height / 58) + 8);
  return (
    <>
      <details className="region-originals" open>
        <summary>
          <LockKeyhole size={13} />
          Original signals <span>{raw.length}</span>
        </summary>
        {raw.map((node) => (
          <button key={node.id} onClick={() => onRaw(node.id)}>
            <i style={{ background: node.color }} />
            {node.name}
            <small>{node.unit}</small>
          </button>
        ))}
      </details>
      <div
        className="region-history-scroll"
        ref={viewport}
        onScroll={(event) => setTop(event.currentTarget.scrollTop)}
        aria-label="Chronological function history"
      >
        <div style={{ height: items.length * 58, position: 'relative' }}>
          {visible.map((item, index) => (
            <button
              key={item.id}
              className={`region-history-row ${item.id === selectedId ? 'selected' : ''}`}
              style={{ top: (start + index) * 58 }}
              onClick={() => onSelect(item)}
            >
              <span className="region-step">
                {String(start + index + 1).padStart(2, '0')}
              </span>
              <span className="region-history-icon">
                {item.set ? (
                  <Scissors size={15} />
                ) : item.run?.operation === 'min-max' ? (
                  <Table2 size={15} />
                ) : (
                  <Sigma size={15} />
                )}
              </span>
              <span className="region-history-title">
                <strong>
                  {item.set
                    ? `Segment · ${item.set.name}`
                    : operationLabels[item.run!.operation]}
                </strong>
                <small>
                  {item.set
                    ? `v${item.set.version} · ${item.set.regions.length} regions${item.set.parentSetId ? ' · within parent regions' : ''}`
                    : `${item.run!.outputs.length} ${item.run!.operation === 'min-max' ? 'table rows' : 'signal results'}${item.run!.regionSetId ? ' · scoped to regions' : ' · input extent'}`}
                </small>
              </span>
            </button>
          ))}
        </div>
      </div>
      <p className="region-history-foot">
        One function per item · select to inspect inputs and settings
      </p>
    </>
  );
}
