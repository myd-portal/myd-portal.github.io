"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { collection, getDocs, query, where, type QueryDocumentSnapshot, type WhereFilterOp } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "@/lib/firebase";
import { formatTevAmount, loadTevRegionRates, totalsForRecord, type TevItinerary, type TevRegionRate } from "@/lib/mytev";
import { matchesAdminSearch } from "@/lib/admin-search";
import RecordPagination, { useRecordPagination } from "./RecordPagination";
import { LEGACY_PENDING_STATUS } from "./workflow-status";
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
  onOpenRecord: (record: FindDocsRecord) => void;
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

export default function FindDocs({ user, unit, onOpenRecord }: FindDocsProps) {
  const [records, setRecords] = useState<FindDocsRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<FindDocsType | "all">("all");
  const [tevRates, setTevRates] = useState<TevRegionRate[] | null>(null);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const scopeKey = `${user.uid}:${unit ?? ""}`;
  const searchInitiated = Boolean(search.trim()) || typeFilter !== "all";

  useEffect(() => {
    let active = true;
    void loadTevRegionRates().then((rates) => { if (active) setTevRates(rates); }).catch(() => { if (active) setTevRates(null); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!searchInitiated || loadedScope === scopeKey) return;
    if (!db) { setRecords([]); setLoading(false); setError("Document storage is unavailable."); setLoadedScope(scopeKey); return; }
    let active = true;
    setLoading(true);
    setError("");
    setRecords([]);
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
      setLoadedScope(scopeKey);
    }).catch((cause) => {
      if (!active) return;
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not load your documents (${code}).` : "Could not load your documents. Refresh and try again.");
      setRecords([]);
      setLoading(false);
      setLoadedScope(scopeKey);
    });
    return () => { active = false; };
  }, [loadedScope, scopeKey, searchInitiated, unit, user.uid]);

  const filteredRecords = useMemo(() => records.filter((record) => (typeFilter === "all" || record.type === typeFilter)
    && matchesAdminSearch(rowSearchContent(record, tevRates), search)), [records, search, typeFilter, tevRates]);
  const { currentPage, pageCount, visibleRecords, setPage } = useRecordPagination(filteredRecords);

  const groupedRecords = useMemo(() => findDocsTypes.map((type) => ({
    type,
    records: visibleRecords.filter((record) => record.type === type),
  })).filter((group) => group.records.length), [visibleRecords]);

  return <section className="content-section find-docs-section">
    <div className="section-heading"><div><p className="eyebrow">My Desk · Document search</p><h2>findDocs</h2><p className="muted">Search documents saved by or shared with your account.</p></div><span className="find-docs-count">{searchInitiated && loadedScope === scopeKey ? `${filteredRecords.length} ${filteredRecords.length === 1 ? "document" : "documents"}` : "Search to view"}</span></div>
    <div className="find-docs-filters">
      <label className="find-docs-search">Search documents<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search titles, dates, status, names…" /></label>
      <label>Document Type<select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as FindDocsType | "all")}><option value="all">All document types</option>{findDocsTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
    </div>
    {searchInitiated && error && <p className="error-message find-docs-error" role="alert">{error}</p>}
    {!searchInitiated ? <div className="empty-state find-docs-empty"><span className="empty-number">00</span><h3>Search to view your documents</h3><p>Enter a search term or choose a document type to display matching records.</p></div> : loading || loadedScope !== scopeKey ? <p className="muted" role="status">Searching your documents…</p> : filteredRecords.length === 0 ? <div className="empty-state find-docs-empty"><span className="empty-number">00</span><h3>{records.length ? "No documents match your search" : "No documents found"}</h3><p>{records.length ? "Change the document type or search terms and try again." : "Documents saved by or shared with your account will appear here."}</p></div> : <div className="find-docs-results">
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
                <span className="find-docs-actions" data-label="Action" role="cell"><button type="button" className="row-action" onClick={() => onOpenRecord(record)}>View</button></span>
              </div>;
            })}
          </div>
        </section>;
      })}
    </div>}
  </section>;
}
