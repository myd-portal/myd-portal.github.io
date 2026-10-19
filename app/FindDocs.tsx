"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { collection, getDocs, query, where, type QueryDocumentSnapshot, type WhereFilterOp } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "@/lib/firebase";
import { formatTevAmount, loadTevRegionRates, totalsForRecord, type TevItinerary, type TevRegionRate } from "@/lib/mytev";
import { matchesAdminSearch } from "@/lib/admin-search";
import RecordPagination, { useRecordPagination } from "./RecordPagination";
import { LEGACY_PENDING_STATUS } from "./workflow-status";
import { loadPdfTools } from "@/lib/pdf-tools";
import "./find-docs.css";

export const findDocsTypes = [
  "Special Order",
  "Notice to Attend",
  "Permit Slip",
  "Travel Order",
  "Calendar of Activities",
  "myAR",
  "myTEV",
  "myLeave",
] as const;

export type FindDocsType = (typeof findDocsTypes)[number];
export type FindDocsRecord = { id: string; type: FindDocsType; data: Record<string, unknown> };

type FindDocsProps = {
  user: User;
  unit: string | null;
};

type Filter = [field: string, operator: WhereFilterOp, value: string | string[]];

function recordFromSnapshot(snapshot: QueryDocumentSnapshot) {
  return { id: snapshot.id, ...snapshot.data() } as Record<string, unknown> & { id: string };
}

async function loadCollection(collectionName: string, filterGroups: Filter[][]) {
  const snapshots = await Promise.all(filterGroups.map((filters) => getDocs(query(
    collection(db!, collectionName),
    ...filters.map(([field, operator, value]) => where(field, operator, value)),
  ))));
  const records = new Map<string, Record<string, unknown> & { id: string }>();
  snapshots.forEach((snapshot) => snapshot.docs.forEach((item) => records.set(item.id, recordFromSnapshot(item))));
  return [...records.values()];
}

function text(value: unknown, fallback = "—") {
  if (typeof value === "string" || typeof value === "number") return String(value).trim() || fallback;
  return fallback;
}

function dateLabel(value: unknown) {
  if (typeof value !== "string" || !value) return "—";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-PH", { dateStyle: "medium" }).format(date);
}

function dateRange(from: unknown, to: unknown) {
  const start = dateLabel(from);
  const end = dateLabel(to);
  return start === end ? start : `${start} – ${end}`;
}

function monthLabel(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}$/.test(value)) return text(value);
  return new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}-01T00:00:00Z`));
}

function valuesForRecord(record: FindDocsRecord, tevRates?: TevRegionRate[] | null): { columns: string[]; values: string[] } {
  const data = record.data;
  switch (record.type) {
    case "Special Order":
      return { columns: ["Subject", "Activity", "Schedule"], values: [text(data.subject), text(data.activityTitle), dateRange(data.dateFrom, data.dateTo)] };
    case "Notice to Attend": {
      const batches = Array.isArray(data.batches) ? data.batches as Array<Record<string, unknown>> : [];
      const schedules = batches.map((batch) => dateRange(batch.dateFrom, batch.dateTo)).filter((item) => item !== "—");
      const schedule = data.mode === "individual" || !schedules.length
        ? dateRange(data.dateFrom, data.dateTo)
        : [...new Set(schedules)].join(", ");
      return { columns: ["Subject", "Activity", "Schedule"], values: [text(data.subject), text(data.activityTitle), schedule] };
    }
    case "Permit Slip": {
      const names = Array.isArray(data.names) ? data.names.filter((name): name is string => typeof name === "string") : [text(data.name, "")].filter(Boolean);
      const permitNumbers = Array.isArray(data.permitNos) ? data.permitNos.filter((value): value is string => typeof value === "string" && Boolean(value.trim())) : [];
      return { columns: ["Permit No.", "Date", "Name", "Office"], values: [text(data.permitNo, permitNumbers.join(", ") || "—"), dateLabel(data.date), names.join(", ") || "—", text(data.ownerOffice ?? data.office ?? data.unit)] };
    }
    case "Travel Order": {
      return { columns: ["Departure / Return Date", "Place of Travel", "Purpose", "Status"], values: [dateRange(data.departureDate, data.returnDate), text(data.placeOfTravel), text(data.purpose), text(data.status)] };
    }
    case "Calendar of Activities": {
      const activities = Array.isArray(data.activities) ? data.activities as Array<Record<string, unknown>> : [];
      const activityNames = activities.map((activity) => text(activity.activity, "")).filter(Boolean).join(" · ");
      return { columns: ["Month and Year", "Unit / Program / Project", "Activities", "Status"], values: [monthLabel(data.month), text(data.unit), activityNames || `${activities.length} activities`, text(data.status, "Pending")] };
    }
    case "myAR":
      return { columns: ["Month", "Half-month Cycle"], values: [monthLabel(data.month), Number(data.cycle) === 1 ? "First half (1–15)" : Number(data.cycle) === 2 ? "Second half (16–end)" : text(data.cycle)] };
    case "myTEV": {
      const itineraries = Array.isArray(data.itineraries) ? data.itineraries as TevItinerary[] : [];
      const savedTotal = typeof data.totalAmount === "number" && Number.isFinite(data.totalAmount) ? data.totalAmount : null;
      const totalAmount = tevRates && itineraries.length ? totalsForRecord(itineraries, tevRates).grandTotal : savedTotal;
      const total = totalAmount === null ? "—" : `₱${formatTevAmount(totalAmount)}`;
      return { columns: ["Travel Month", "Total Amount"], values: [monthLabel(data.month), total] };
    }
    case "myLeave":
      return { columns: ["Date Filed", "Name", "Type of Leave", "Inclusive Dates", "Status"], values: [dateLabel(data.filedDate), text(data.name), text(data.leaveType), dateRange(data.inclusiveDateFrom, data.inclusiveDateTo), text(data.status, "Pending")] };
  }
}

function rowSearchContent(record: FindDocsRecord, tevRates?: TevRegionRate[] | null) {
  return [record.type, ...valuesForRecord(record, tevRates).values, record.data];
}

const hiddenDetailFields = new Set([
  "id", "ownerId", "ownerUnit", "recipientIds", "personIds", "userId", "createdAt", "updatedAt", "submittedAt",
]);

function detailLabel(value: string) {
  const labels: Record<string, string> = {
    dateFrom: "Date From",
    dateTo: "Date To",
    filedDate: "Date Filed",
    inclusiveDateFrom: "Inclusive Date From",
    inclusiveDateTo: "Inclusive Date To",
    departureDate: "Departure Date",
    returnDate: "Return Date",
    activityTitle: "Activity Title",
    venueType: "Venue Type",
    placeOfTravel: "Place of Travel",
    totalAmount: "Total Amount",
    permitNo: "Permit Number",
    permitNos: "Permit Numbers",
    ownerOffice: "Office",
    ownerDivision: "Division",
    ownerUnit: "Unit",
  };
  return labels[value] ?? value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}

function detailText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    const date = (value.toDate as () => Date)();
    return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short" }).format(date);
  }
  return "";
}

function renderDetailValue(value: unknown): ReactNode {
  const primitive = detailText(value);
  if (primitive) return primitive;
  if (Array.isArray(value)) {
    const visibleItems = value.filter((item) => item !== null && item !== undefined && item !== "");
    if (!visibleItems.length) return "—";
    if (visibleItems.every((item) => typeof item !== "object")) return visibleItems.map((item) => detailText(item)).join(", ");
    return <div className="find-docs-detail-list">{visibleItems.map((item, index) => <div className="find-docs-detail-item" key={index}>{renderDetailValue(item)}</div>)}</div>;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([key, item]) => !hiddenDetailFields.has(key) && item !== undefined && item !== null && item !== "");
    if (!entries.length) return "—";
    return <dl className="find-docs-detail-fields">{entries.map(([key, item]) => <div className="find-docs-detail-field" key={key}><dt>{detailLabel(key)}</dt><dd>{renderDetailValue(item)}</dd></div>)}</dl>;
  }
  return "—";
}

function recordDetails(record: FindDocsRecord): Array<[string, unknown]> {
  return Object.entries(record.data).filter(([key, value]) => !hiddenDetailFields.has(key) && value !== undefined && value !== null && value !== "");
}

function FindDocsDetail({ record, onClose }: { record: FindDocsRecord; onClose: () => void }) {
  const detailRef = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const canExport = record.type !== "myAR";

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  async function downloadPdf() {
    if (!detailRef.current) return;
    setBusy(true);
    setActionError("");
    try {
      if (document.fonts?.ready) await document.fonts.ready;
      const { html2canvas, jsPDF } = await loadPdfTools();
      const canvas = await html2canvas(detailRef.current, { backgroundColor: "#fff", logging: false, scale: 2, useCORS: true, windowWidth: detailRef.current.scrollWidth });
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const pageHeight = canvas.width * (297 / 210);
      let offsetY = 0;
      let page = 0;
      while (offsetY < canvas.height) {
        const sliceHeight = Math.min(pageHeight, canvas.height - offsetY);
        const slice = document.createElement("canvas");
        slice.width = canvas.width;
        slice.height = sliceHeight;
        const context = slice.getContext("2d");
        if (!context) throw new Error("Unable to prepare the document PDF.");
        context.drawImage(canvas, 0, offsetY, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);
        if (page > 0) pdf.addPage("a4", "portrait");
        const renderedHeight = 297 * (sliceHeight / pageHeight);
        pdf.addImage(slice.toDataURL("image/jpeg", .94), "JPEG", 0, 0, 210, renderedHeight);
        offsetY += sliceHeight;
        page += 1;
      }
      const filename = `${record.type.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${record.id}.pdf`;
      pdf.save(filename);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Unable to create this document PDF.");
    } finally {
      setBusy(false);
    }
  }

  async function printDocument() {
    if (document.fonts?.ready) await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    window.print();
  }

  return <div className="find-docs-detail-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="find-docs-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="find-docs-detail-title">
      <div className="find-docs-detail-toolbar">
        <span>{record.type}</span>
        <div className="find-docs-detail-actions">
          {canExport && <><button type="button" className="ghost-button" onClick={printDocument} disabled={busy}>Print</button><button type="button" className="pdf-button" onClick={() => void downloadPdf()} disabled={busy}>{busy ? "Preparing PDF…" : "Download PDF"}</button></>}
          <button type="button" className="ghost-button" onClick={onClose}>Close</button>
        </div>
      </div>
      {actionError && <p className="error-message find-docs-detail-error" role="alert">{actionError}</p>}
      <article className="find-docs-detail-paper" ref={detailRef}>
        <p className="eyebrow">My Desk · {record.type}</p>
        <h2 id="find-docs-detail-title">{record.type} details</h2>
        <p className="find-docs-detail-reference">Document reference: {record.id}</p>
        <dl className="find-docs-detail-fields find-docs-detail-root-fields">{recordDetails(record).map(([key, value]) => <div className="find-docs-detail-field" key={key}><dt>{detailLabel(key)}</dt><dd>{renderDetailValue(value)}</dd></div>)}</dl>
      </article>
    </div>
  </div>;
}

export default function FindDocs({ user, unit }: FindDocsProps) {
  const [records, setRecords] = useState<FindDocsRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<FindDocsType | "all">("all");
  const [tevRates, setTevRates] = useState<TevRegionRate[] | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<FindDocsRecord | null>(null);

  useEffect(() => {
    let active = true;
    void loadTevRegionRates().then((rates) => { if (active) setTevRates(rates); }).catch(() => { if (active) setTevRates(null); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!db) { setRecords([]); setLoading(false); setError("Document storage is unavailable."); return; }
    let active = true;
    setLoading(true);
    setError("");
    const sharedFilters = (): Filter[][] => [
      [["ownerId", "==", user.uid]],
      ...(unit ? [[["ownerUnit", "==", unit]] as Filter[]] : []),
      [["recipientIds", "array-contains", user.uid]],
    ];
    const request = Promise.all([
      loadCollection("specialOrders", sharedFilters()),
      loadCollection("ntaRecords", sharedFilters()),
      loadCollection("permits", [
        [["ownerId", "==", user.uid]],
        [["recipientIds", "array-contains", user.uid]],
        [["personIds", "array-contains", user.uid]],
      ]),
      loadCollection("travelOrders", [
        [["ownerId", "==", user.uid]],
        [["recipientId", "==", user.uid]],
        [["status", "in", ["Approved", "Pending", "Disapproved", LEGACY_PENDING_STATUS]]],
      ]),
      loadCollection("calendarOfActivities", [
        [["ownerId", "==", user.uid]],
        ...(unit ? [[["unit", "==", unit]] as Filter[]] : []),
      ]),
      loadCollection("accomplishmentReports", [[["ownerId", "==", user.uid]]]),
      loadCollection("myTevRecords", [[["ownerId", "==", user.uid]]]),
      loadCollection("leaveApplications", [[["ownerId", "==", user.uid]]]),
    ]);
    request.then(([specialOrders, notices, permits, travelOrders, calendars, reports, tevs, leaves]) => {
      if (!active) return;
      const toRows = (type: FindDocsType, data: Array<Record<string, unknown> & { id: string }>) => data.map((item) => ({ id: item.id, type, data: item }));
      const accountTravelOrders = travelOrders.filter((order) => order.ownerId === user.uid
        || order.recipientId === user.uid
        || (Array.isArray(order.people) && order.people.some((person) => person && typeof person === "object" && (person as Record<string, unknown>).userId === user.uid)));
      const allRecords = [
        ...toRows("Special Order", specialOrders),
        ...toRows("Notice to Attend", notices),
        ...toRows("Permit Slip", permits),
        ...toRows("Travel Order", accountTravelOrders),
        ...toRows("Calendar of Activities", calendars),
        ...toRows("myAR", reports),
        ...toRows("myTEV", tevs),
        ...toRows("myLeave", leaves),
      ];
      allRecords.sort((left, right) => {
        const leftValue = left.data.createdAt && typeof left.data.createdAt === "object" && "toMillis" in left.data.createdAt && typeof left.data.createdAt.toMillis === "function" ? left.data.createdAt.toMillis() : 0;
        const rightValue = right.data.createdAt && typeof right.data.createdAt === "object" && "toMillis" in right.data.createdAt && typeof right.data.createdAt.toMillis === "function" ? right.data.createdAt.toMillis() : 0;
        return rightValue - leftValue;
      });
      setRecords(allRecords);
      setLoading(false);
    }).catch((cause) => {
      if (!active) return;
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not load your documents (${code}).` : "Could not load your documents. Refresh and try again.");
      setRecords([]);
      setLoading(false);
    });
    return () => { active = false; };
  }, [user.uid, unit]);

  const filteredRecords = useMemo(() => records.filter((record) => (typeFilter === "all" || record.type === typeFilter)
    && matchesAdminSearch(rowSearchContent(record, tevRates), search)), [records, search, typeFilter, tevRates]);
  const { currentPage, pageCount, visibleRecords, setPage } = useRecordPagination(filteredRecords);

  const groupedRecords = useMemo(() => findDocsTypes.map((type) => ({
    type,
    records: visibleRecords.filter((record) => record.type === type),
  })).filter((group) => group.records.length), [visibleRecords]);

  return <section className="content-section find-docs-section">
    <div className="section-heading"><div><p className="eyebrow">My Desk · Document search</p><h2>findDocs</h2><p className="muted">Search documents saved by or shared with your account.</p></div><span className="find-docs-count">{filteredRecords.length} {filteredRecords.length === 1 ? "document" : "documents"}</span></div>
    <div className="find-docs-filters">
      <label className="find-docs-search">Search documents<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search titles, dates, status, names…" /></label>
      <label>Document Type<select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as FindDocsType | "all")}><option value="all">All document types</option>{findDocsTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
    </div>
    {error && <p className="error-message find-docs-error" role="alert">{error}</p>}
    {loading ? <p className="muted">Loading your documents…</p> : filteredRecords.length === 0 ? <div className="empty-state find-docs-empty"><span className="empty-number">00</span><h3>{records.length ? "No documents match your search" : "No documents found"}</h3><p>{records.length ? "Change the document type or search terms and try again." : "Documents saved by or shared with your account will appear here."}</p></div> : <div className="find-docs-results">
      <RecordPagination totalRecords={filteredRecords.length} currentPage={currentPage} pageCount={pageCount} onPageChange={setPage} label="Find documents" />
      {groupedRecords.map((group) => {
        const columns = valuesForRecord(group.records[0], tevRates).columns;
        const groupId = `find-docs-${group.type.replace(/\W+/g, "-")}`;
        return <section className="find-docs-type-group" key={group.type} aria-labelledby={groupId}>
          <h3 id={groupId}>{group.type}<span>{group.records.length}</span></h3>
          <div className="find-docs-table" role="table" aria-label={`${group.type} documents`}>
            <div className="find-docs-table-head" role="row" style={{ "--find-docs-column-count": columns.length } as CSSProperties}>{columns.map((column) => <span role="columnheader" key={column}>{column}</span>)}<span role="columnheader">Action</span></div>
            {group.records.map((record) => {
              const { values } = valuesForRecord(record, tevRates);
              return <div className="find-docs-table-row" role="row" key={record.id} style={{ "--find-docs-column-count": columns.length } as CSSProperties}>
                {values.map((value, index) => <span className={index === 0 ? "find-docs-primary-value" : ""} data-label={columns[index]} role="cell" key={`${record.id}:${columns[index]}`}>{value}</span>)}
                <span className="find-docs-actions" data-label="Action" role="cell"><button type="button" className="row-action" onClick={() => setSelectedRecord(record)}>View</button></span>
              </div>;
            })}
          </div>
        </section>;
      })}
    </div>}
    {selectedRecord && <FindDocsDetail record={selectedRecord} onClose={() => setSelectedRecord(null)} />}
  </section>;
}
