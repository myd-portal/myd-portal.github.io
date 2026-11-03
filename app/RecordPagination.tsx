"use client";

import { useEffect, useState } from "react";
import { Button } from "./components/ui";

export const recordPageSize = 5;

export function useRecordPagination<T>(records: T[]) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(records.length / recordPageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleRecords = records.slice(currentPage * recordPageSize, (currentPage + 1) * recordPageSize);

  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [currentPage, page]);

  return { currentPage, pageCount, visibleRecords, setPage };
}

export default function RecordPagination({ totalRecords, currentPage, pageCount, onPageChange, label }: { totalRecords: number; currentPage: number; pageCount: number; onPageChange: (page: number) => void; label: string }) {
  if (totalRecords <= recordPageSize) return null;

  const firstRecord = currentPage * recordPageSize + 1;
  const lastRecord = Math.min((currentPage + 1) * recordPageSize, totalRecords);

  return <nav className="record-pagination" aria-label={`${label} pages`}>
    <span className="record-pagination-range">Showing {firstRecord}-{lastRecord} of {totalRecords}</span>
    <div className="record-pagination-controls">
      <Button type="button" variant="outline" size="sm" className="ghost-button" onClick={() => onPageChange(currentPage - 1)} disabled={currentPage === 0}>Previous</Button>
      <span aria-live="polite">Page {currentPage + 1} of {pageCount}</span>
      <Button type="button" variant="outline" size="sm" className="ghost-button" onClick={() => onPageChange(currentPage + 1)} disabled={currentPage >= pageCount - 1}>Next</Button>
    </div>
  </nav>;
}
