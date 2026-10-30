"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { collection, doc, getDoc, getDocs, onSnapshot, query, runTransaction, serverTimestamp, updateDoc, where, writeBatch } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "@/lib/firebase";
import NameSearchSelect from "./NameSearchSelect";
import { loadPdfTools } from "@/lib/pdf-tools";
import { filterPersonnelForDivisionRecipients, loadAccountUnits, loadPersonnel as loadAccountPersonnel, personnelDisplayName, type PersonnelEntry } from "@/lib/personnel";
import { getDocumentNotificationReferences, makeDocumentNotification } from "@/lib/document-notifications";
import DeleteConfirmation from "./DeleteConfirmation";
import { divisionSignatory as getDivisionSignatory } from "@/lib/mytev";
import { formatCurrencyAmount, normalizeCurrencyValue } from "@/lib/currency";
import { LEGACY_PENDING_STATUS, normalizeWorkflowStatus, type WorkflowStatus } from "./workflow-status";
import CurrencyInput from "./CurrencyInput";
import "./travel-order.css";

type TravelOrderStatus = WorkflowStatus;
type TravelOrderPerson = { name: string; userId?: string; position: string; salary: string; toNumber?: string };
type TravelOrder = {
  id: string;
  date: string;
  people: TravelOrderPerson[];
  officeStation: string;
  departureDate: string;
  returnDate: string;
  placeOfTravel: string;
  purpose: string;
  objective: string;
  perDiemsAllowed: "Yes" | "No";
  assistantLaborersAllowed: "Yes" | "No";
  chargeTo: string;
  transportation: string;
  remarks: string;
  status: TravelOrderStatus;
  ownerId: string;
  ownerUnit?: string | null;
  preparedById?: string;
  travelOrderGroupId?: string;
  travelOrderPersonIndex?: number;
  previewPageOrders?: TravelOrder[];
  recipientOwnerSourceId?: string;
  recipientId?: string;
  recipientIds?: string[];
  splitFromOrderId?: string;
  createdAt?: unknown;
};

function mergeSavedTravelOrders(current: TravelOrder[], savedOrders: TravelOrder[], replacedOrderId?: string) {
  const savedById = new Map(savedOrders.map((order) => [order.id, order]));
  return [...savedById.values(), ...current.filter((order) => order.id !== replacedOrderId && !savedById.has(order.id))];
}

const officeStations = ["DA-RFO XIII", "DA-ILD Caraga"] as const;
const legacyChargeOptions = ["FOD-AGRISTAT", "FOD-AMIA", "FOD-DRRM"];
const otherChargeOption = "__travel-order-other__";
const travelTransportationOptions = ["Boat", "MCH", "Plane", "PUB", "PUV", "RP"] as const;
const statuses: TravelOrderStatus[] = ["Pending", "Approved", "Disapproved"];
const asset = (path: string) => `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`;

function travelOrderNumberKey(value: string) {
  return encodeURIComponent(value.trim().toUpperCase());
}

function travelOrderChargeKey(value: string) {
  return value.trim().toLocaleLowerCase("en-PH");
}

function formatTravelDate(value: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-PH", { month: "long", day: "numeric", year: "numeric" }).format(new Date(`${value}T00:00:00`));
}

function formatTravelSalary(value: string) {
  return formatCurrencyAmount(value);
}

function formatTravelDateRange(departureDate: string, returnDate: string) {
  const departure = formatTravelDate(departureDate);
  const returning = formatTravelDate(returnDate);
  if (!departure) return returning;
  if (!returning || departureDate === returnDate) return departure;
  const departureValue = new Date(`${departureDate}T00:00:00`);
  const returnValue = new Date(`${returnDate}T00:00:00`);
  if (departureValue.getFullYear() === returnValue.getFullYear() && departureValue.getMonth() === returnValue.getMonth()) {
    const month = new Intl.DateTimeFormat("en-PH", { month: "long" }).format(departureValue);
    return `${month} ${departureValue.getDate()}–${returnValue.getDate()}, ${departureValue.getFullYear()}`;
  }
  return `${departure} – ${returning}`;
}

function isAssignedTravelOrderRecipient(order: TravelOrder, userId: string) {
  if (order.people.length !== 1) return false;
  return order.recipientId === userId
    || order.recipientIds?.includes(userId) === true
    || order.people.some((person) => person.userId === userId);
}

function canRecipientApproveTravelOrder(order: TravelOrder) {
  return order.people.length === 1;
}

function travelOrderGroupKey(order: TravelOrder) {
  if (order.travelOrderGroupId) return order.travelOrderGroupId;
  const createdAt = order.createdAt as { toMillis?: () => number } | string | undefined;
  const createdAtKey = typeof createdAt === "string" ? createdAt : createdAt?.toMillis?.();
  if (!createdAtKey) return order.id;
  const detailsKey = [order.departureDate, order.returnDate, order.placeOfTravel, order.purpose, order.officeStation].join("|");
  return `legacy-${order.ownerId}-${createdAtKey}-${encodeURIComponent(detailsKey)}`;
}

function withOwnerTravelOrderPages(order: TravelOrder, orders: TravelOrder[], ownerId: string) {
  if (order.ownerId !== ownerId) return order;
  const pageOrders = orders.filter((candidate) => candidate.ownerId === ownerId && travelOrderGroupKey(candidate) === travelOrderGroupKey(order))
    .sort((left, right) => (left.travelOrderPersonIndex ?? Number.MAX_SAFE_INTEGER) - (right.travelOrderPersonIndex ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id));
  return { ...order, previewPageOrders: pageOrders.length ? pageOrders : [order] };
}

function travelOrderApprovalPeople(pageOrders: TravelOrder[]) {
  let index = 0;
  return pageOrders.flatMap((pageOrder) => pageOrder.people.map((person, personIndex) => ({ pageOrder, person, personIndex, index: index++ })));
}

function TravelOrderForm({ user, office, division, unit, initialOrder, onSaved, onCancel, onError }: { user: User; office: string; division: string; unit: string | null; initialOrder?: TravelOrder; onSaved: (orders: TravelOrder[], replacedOrderId?: string) => void; onCancel: () => void; onError: (message: string) => void }) {
  const [people, setPeople] = useState<TravelOrderPerson[]>(() => initialOrder?.people.map((person) => ({ ...person })) ?? [{ name: "", position: "", salary: "" }]);
  const [officeStation, setOfficeStation] = useState<(typeof officeStations)[number]>(initialOrder?.officeStation as (typeof officeStations)[number] ?? officeStations[0]);
  const [personnel, setPersonnel] = useState<PersonnelEntry[]>([]);
  const [personnelStatus, setPersonnelStatus] = useState<"loading" | "ready" | "error">("loading");
  const [accountUnits, setAccountUnits] = useState<string[]>([]);
  const [accountUnitsStatus, setAccountUnitsStatus] = useState<"loading" | "ready" | "error">("loading");
  const [departureDate, setDepartureDate] = useState(initialOrder?.departureDate ?? "");
  const [returnDate, setReturnDate] = useState(initialOrder?.returnDate ?? "");
  const [placeOfTravel, setPlaceOfTravel] = useState(initialOrder?.placeOfTravel ?? "");
  const [purpose, setPurpose] = useState(initialOrder?.purpose ?? "");
  const [objective, setObjective] = useState(initialOrder?.objective ?? "");
  const [perDiemsAllowed, setPerDiemsAllowed] = useState<"" | "Yes" | "No">(initialOrder?.perDiemsAllowed ?? "");
  const [assistantLaborersAllowed, setAssistantLaborersAllowed] = useState<"" | "Yes" | "No">(initialOrder?.assistantLaborersAllowed ?? "");
  const [chargeTo, setChargeTo] = useState(initialOrder?.chargeTo ?? "");
  const [chargeToIsOther, setChargeToIsOther] = useState(() => Boolean(initialOrder?.chargeTo && !legacyChargeOptions.includes(initialOrder.chargeTo)));
  const [transportation, setTransportation] = useState<string[]>(() => {
    const selected = new Set((initialOrder?.transportation ?? "").split(/,\s*/).map((option) => option === "Plane (GS)" || option === "Plane (Credit)" ? "Plane" : option));
    return travelTransportationOptions.filter((option) => selected.has(option));
  });
  const [remarks, setRemarks] = useState(initialOrder?.remarks ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadPersonnel() {
      try {
        const entries = filterPersonnelForDivisionRecipients(await loadAccountPersonnel({ deduplicateByName: false }), division);
        if (!cancelled) {
          setPersonnel(entries);
          setPersonnelStatus("ready");
        }
      } catch {
        if (!cancelled) setPersonnelStatus("error");
      }
    }
    void loadPersonnel();
    return () => { cancelled = true; };
  }, [division]);

  useEffect(() => {
    let cancelled = false;
    async function loadUnits() {
      try {
        const entries = await loadAccountUnits();
        if (!cancelled) {
          setAccountUnits(entries);
          setAccountUnitsStatus("ready");
          const existingChargeTo = initialOrder?.chargeTo?.trim() ?? "";
          if (existingChargeTo && entries.some((entry) => travelOrderChargeKey(entry) === travelOrderChargeKey(existingChargeTo))) {
            setChargeToIsOther(false);
          }
        }
      } catch {
        if (!cancelled) setAccountUnitsStatus("error");
      }
    }
    void loadUnits();
    return () => { cancelled = true; };
  }, [initialOrder?.chargeTo]);

  const initialChargeTo = initialOrder?.chargeTo?.trim() ?? "";
  const retainedChargeOption = initialChargeTo && !chargeToIsOther && !accountUnits.some((entry) => travelOrderChargeKey(entry) === travelOrderChargeKey(initialChargeTo))
    ? [initialChargeTo]
    : [];
  const chargeUnitOptions = [...accountUnits, ...retainedChargeOption];

  function updatePerson(index: number, update: Partial<TravelOrderPerson>) {
    setPeople((current) => current.map((person, itemIndex) => itemIndex === index ? { ...person, ...update } : person));
  }

  const selectedPersonnelIds = new Set(people.flatMap((person) => person.userId ? [person.userId] : []));
  const travelersLocked = Boolean(initialOrder?.people.some((person) => person.toNumber));

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!db) { onError("Firebase is not configured."); return; }
    if (!unit) { onError("Your Unit / Program / Project is still loading. Try saving again in a moment."); return; }
    if (!transportation.length) { onError("Select at least one means of transportation."); return; }
    const normalizedChargeTo = chargeTo.trim();
    if (!normalizedChargeTo) { onError("Select or enter an appropriation to charge this Travel Order to."); return; }
    const normalizedPeople = people.map((person) => ({ ...person, name: person.name.trim(), position: person.position.trim(), salary: normalizeCurrencyValue(person.salary) }));
    if (!normalizedPeople.length || normalizedPeople.some((person) => !person.userId)) {
      onError("Select a registered account for each person so every Travel Order can be assigned privately.");
      return;
    }
    setBusy(true);
    onError("");
    const record = {
      date: initialOrder?.date ?? "",
      officeStation,
      departureDate,
      returnDate,
      placeOfTravel: placeOfTravel.trim(),
      purpose: purpose.trim(),
      objective: objective.trim(),
      perDiemsAllowed: perDiemsAllowed as "Yes" | "No",
      assistantLaborersAllowed: assistantLaborersAllowed as "Yes" | "No",
      chargeTo: normalizedChargeTo,
      transportation: travelTransportationOptions.filter((option) => transportation.includes(option)).join(", "),
      remarks: remarks.trim(),
      status: initialOrder?.status ?? "Pending" as const,
      ownerId: user.uid,
      ownerUnit: unit,
    };
    try {
      const firestore = db;
      const batch = writeBatch(firestore);
      const mustSplitRecord = !initialOrder || initialOrder.people.length !== 1 || normalizedPeople.length !== 1;
      const travelOrderGroupId = initialOrder?.travelOrderGroupId ?? (initialOrder ? travelOrderGroupKey(initialOrder) : doc(collection(firestore, "travelOrders")).id);
      if (initialOrder) {
        const existingNotifications = await getDocs(query(collection(firestore, "documentNotifications"), where("ownerId", "==", user.uid), where("documentId", "==", initialOrder.id)));
        existingNotifications.docs.forEach((notification) => batch.delete(notification.ref));
        if (mustSplitRecord) batch.delete(doc(firestore, "travelOrders", initialOrder.id));
      }

      const savedOrders: TravelOrder[] = [];
      for (const [personIndex, person] of normalizedPeople.entries()) {
        const recipientId = person.userId!;
        const personalRecord = {
          ...record,
          people: [person],
          travelOrderGroupId,
          travelOrderPersonIndex: initialOrder?.people.length === 1 && normalizedPeople.length === 1 && typeof initialOrder.travelOrderPersonIndex === "number" ? initialOrder.travelOrderPersonIndex : personIndex,
          recipientId,
          recipientIds: [recipientId],
          ...(initialOrder && !mustSplitRecord ? { updatedAt: serverTimestamp() } : { createdAt: serverTimestamp() }),
        };
        const orderRef = initialOrder && !mustSplitRecord
          ? doc(firestore, "travelOrders", initialOrder.id)
          : doc(collection(firestore, "travelOrders"));
        if (initialOrder && !mustSplitRecord) batch.update(orderRef, personalRecord);
        else batch.set(orderRef, personalRecord);
        if (recipientId !== user.uid) {
          const notification = makeDocumentNotification(firestore, { recipientId, ownerId: user.uid, documentId: orderRef.id, documentType: "Travel Order", departureDate, returnDate, placeOfTravel: personalRecord.placeOfTravel, purpose: personalRecord.purpose });
          batch.set(notification.reference, notification.data);
        }
        savedOrders.push({ id: orderRef.id, ...personalRecord, createdAt: initialOrder && !mustSplitRecord ? initialOrder.createdAt : undefined });
      }
      await batch.commit();
      onSaved(savedOrders, initialOrder?.id);
    } catch (error) {
      const code = (error as { code?: string }).code;
      onError(code ? `Could not save the Travel Order (${code}).` : "Could not save the Travel Order. Try again.");
    } finally { setBusy(false); }
  }

  return <section className="content-section form-section travel-order-form-section">
    <div className="section-heading"><div><p className="eyebrow">{initialOrder ? "Edit record" : "New record"}</p><h2>{initialOrder ? "Edit Travel Order" : "Create Travel Order"}</h2><p className="muted">{initialOrder ? travelersLocked ? "Update the travel details. The assigned TO numbers and personnel are preserved." : "Update the travel details or traveler list." : "One A4 Travel Order page will be generated for each person. The date and TO No. are entered when approving."}</p></div><button type="button" className="ghost-button" onClick={onCancel}>Cancel</button></div>
    <form className="permit-form travel-order-form" onSubmit={save}>
      <label className="travel-order-office-field">Office Station<select value={officeStation} onChange={(event) => setOfficeStation(event.target.value as (typeof officeStations)[number])} required>{officeStations.map((station) => <option key={station}>{station}</option>)}</select></label>
      <div className="travel-order-people wide-field">
        <div className="travel-order-people-heading"><strong>Persons traveling</strong><span>{travelersLocked ? "Assigned TO numbers lock this traveler list." : "Add each person who needs a separate Travel Order page."}</span></div>
        {personnelStatus === "error" && <p className="travel-order-number-error" role="alert">Unable to load personnel from user accounts. Reload the page to try again.</p>}
        {people.map((person, index) => <fieldset className="travel-order-person" key={index} disabled={travelersLocked}>
          <legend>Personnel {index + 1}</legend>
          <div className="name-search-field"><span>Name</span><NameSearchSelect aria-label={`Personnel name ${index + 1}`} value={person.userId ?? ""} onChange={(userId) => { const selectedPerson = personnel.find((entry) => entry.userId === userId); updatePerson(index, { userId, name: selectedPerson?.name ?? "", position: selectedPerson?.position ?? "" }); }} required disabled={personnelStatus !== "ready"}><option value="" disabled>{personnelStatus === "loading" ? "Loading personnel..." : personnelStatus === "error" ? "Personnel list unavailable" : "Select a personnel"}</option>{personnel.filter((entry) => entry.userId === person.userId || !selectedPersonnelIds.has(entry.userId)).map((entry) => <option key={entry.userId} value={entry.userId}>{personnelDisplayName(entry)}</option>)}</NameSearchSelect></div>
          <label>Position<input value={person.position} readOnly required /></label>
          <label>Monthly Salary <span className="muted-inline">(optional)</span><div className="travel-order-currency-field"><span aria-hidden="true">₱</span><CurrencyInput value={person.salary} onValueChange={(salary) => updatePerson(index, { salary })} aria-label="Monthly salary amount in Philippine pesos" placeholder="0.00" /></div></label>
          {people.length > 1 && <button type="button" className="remove-participant" aria-label={`Delete person ${index + 1}`} onClick={() => setPeople((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Delete</button>}
        </fieldset>)}
        {!travelersLocked && <button type="button" className="text-button plain-action add-item-text-button" onClick={() => setPeople((current) => [...current, { name: "", position: "", salary: "" }])}>+ Add Personnel</button>}
      </div>
      <div className="date-range-field wide-field travel-order-date-range"><span>Departure Date to Return Date</span><div><input aria-label="Departure date" type="date" value={departureDate} onChange={(event) => setDepartureDate(event.target.value)} required /><span>to</span><input aria-label="Return date" type="date" min={departureDate} value={returnDate} onChange={(event) => setReturnDate(event.target.value)} required /></div></div>
      <div className="travel-order-trip-details wide-field">
        <label>Place of Travel<input value={placeOfTravel} onChange={(event) => setPlaceOfTravel(event.target.value)} required /></label>
        <label>Specific Purpose of the Trip<textarea rows={2} value={purpose} onChange={(event) => setPurpose(event.target.value)} required /></label>
        <label>Objective(s)<textarea rows={2} value={objective} onChange={(event) => setObjective(event.target.value)} required /></label>
      </div>
      <div className="travel-order-allowances wide-field">
        <label>Per Diems Allowed<select value={perDiemsAllowed} onChange={(event) => setPerDiemsAllowed(event.target.value as "" | "Yes" | "No")} required><option value="" disabled>Select Yes or No</option><option>Yes</option><option>No</option></select></label>
        <label>Assistant Laborers Allowed<select value={assistantLaborersAllowed} onChange={(event) => setAssistantLaborersAllowed(event.target.value as "" | "Yes" | "No")} required><option value="" disabled>Select Yes or No</option><option>Yes</option><option>No</option></select></label>
        <label>Charge to{chargeToIsOther ? <><input list="travel-order-charge-options" aria-label="Charge to" value={chargeTo} onChange={(event) => setChargeTo(event.target.value)} placeholder="Enter appropriation" required /><datalist id="travel-order-charge-options">{accountUnits.map((option) => <option key={option} value={option} />)}</datalist></> : <NameSearchSelect aria-label="Charge to" value={chargeTo} onChange={(value) => { if (value === otherChargeOption) { setChargeToIsOther(true); setChargeTo(""); } else { setChargeToIsOther(false); setChargeTo(value); } }} searchPlaceholder="Search units..." optionNoun="unit" required disabled={accountUnitsStatus === "loading"}><option value="" disabled>{accountUnitsStatus === "loading" ? "Loading units..." : accountUnitsStatus === "error" ? "Unit list unavailable" : "Select a unit"}</option>{chargeUnitOptions.map((option) => <option key={option} value={option}>{option}</option>)}<option value={otherChargeOption}>Others</option></NameSearchSelect>}{accountUnitsStatus === "error" && <span className="travel-order-number-error" role="status">Unable to load units from user accounts. You can still select Others.</span>}</label>
      </div>
      <fieldset className="travel-order-transportation-field wide-field">
        <legend>Means of Transportation</legend>
        <div className="travel-order-transportation-options">{travelTransportationOptions.map((option) => <label className="travel-order-transportation-option" key={option}><input type="checkbox" checked={transportation.includes(option)} onChange={(event) => setTransportation((current) => event.target.checked ? [...current, option] : current.filter((selected) => selected !== option))} />{option}</label>)}</div>
      </fieldset>
      <label className="wide-field">Remarks or Special Instructions <span className="muted-inline">(optional)</span><input value={remarks} onChange={(event) => setRemarks(event.target.value)} placeholder="Enter any remarks or special instructions" /></label>
      <div className="form-actions"><button className="primary-button" disabled={busy}>{busy ? "Saving..." : "Save"}</button></div>
    </form>
  </section>;
}

function TravelOrderList({ orders, ownerId, preparedByNames, fallbackPreparedBy, onNew, onEdit, onPreview, onCopy, onDelete, onStatusChange, updatingId, deletingId, copyingId }: { orders: TravelOrder[]; ownerId: string; preparedByNames: Record<string, string>; fallbackPreparedBy: string; onNew: () => void; onEdit: (order: TravelOrder) => void; onPreview: (order: TravelOrder) => void; onCopy: (order: TravelOrder) => void; onDelete: (order: TravelOrder) => void; onStatusChange: (order: TravelOrder, status: TravelOrderStatus, date?: string, toNumbers?: string[], pageOrders?: TravelOrder[]) => Promise<boolean>; updatingId: string | null; deletingId: string | null; copyingId: string | null }) {
  const pageSize = 5;
  const [currentPage, setCurrentPage] = useState(0);
  const [approvalOrderId, setApprovalOrderId] = useState<string | null>(null);
  const [approvalDates, setApprovalDates] = useState<string[]>([]);
  const [approvalNumbers, setApprovalNumbers] = useState<string[]>([]);
  const sortedOrders = [...orders].sort((left, right) =>
    (right.departureDate ?? "").localeCompare(left.departureDate ?? "")
    || (right.returnDate ?? "").localeCompare(left.returnDate ?? "")
    || right.id.localeCompare(left.id));
  const pageCount = Math.max(1, Math.ceil(sortedOrders.length / pageSize));
  const visibleOrders = sortedOrders.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const ownerOrderGroups = new Map<string, TravelOrder[]>();
  orders.filter((order) => order.ownerId === ownerId).forEach((order) => {
    const key = travelOrderGroupKey(order);
    ownerOrderGroups.set(key, [...(ownerOrderGroups.get(key) ?? []), order]);
  });

  useEffect(() => {
    setCurrentPage((page) => Math.min(page, pageCount - 1));
  }, [pageCount]);

  function updateApprovalNumber(index: number, value: string) {
    setApprovalNumbers((current) => current.map((number, itemIndex) => itemIndex === index ? value : number));
  }

  function updateApprovalDate(index: number, value: string) {
    setApprovalDates((current) => current.map((date, itemIndex) => itemIndex === index ? value : date));
  }

  async function updateApprovedPerson(pageOrder: TravelOrder, personIndex: number, groupOrders: TravelOrder[]) {
    if (pageOrder.status !== "Pending") return;
    const groupApprovalPeople = travelOrderApprovalPeople(groupOrders);
    const pagePeople = groupApprovalPeople.filter(({ pageOrder: candidate }) => candidate.id === pageOrder.id);
    const numbers = pagePeople.map(({ index }) => (approvalNumbers[index] ?? "").trim());
    const dateIndex = pagePeople.find(({ personIndex: index }) => index === personIndex)?.index ?? pagePeople[0]?.index ?? 0;
    const date = approvalDates[dateIndex] ?? "";
    await onStatusChange(pageOrder, "Approved", date, numbers, [pageOrder]);
  }

  return <section className="content-section travel-order-list-section">
    <div className="section-heading"><div><p className="eyebrow">Your records</p><h2>Travel Orders</h2><p className="muted">{orders.length} {orders.length === 1 ? "Travel Order" : "Travel Orders"} available to your account.</p></div><button className="primary-button" onClick={onNew}>Add</button></div>
    {orders.length === 0 ? <div className="empty-state"><span className="empty-number">00</span><h3>No Travel Orders yet</h3><p>Create a Travel Order for one or more personnel.</p><button className="text-button plain-action document-create-action" onClick={onNew}>Add a Travel Order</button></div> : <div className="permit-table">
      {orders.length > pageSize && <nav className="travel-order-pagination" aria-label="Travel Order pages"><span>Showing {currentPage * pageSize + 1}-{Math.min((currentPage + 1) * pageSize, orders.length)} of {orders.length}</span><div className="travel-order-pagination-controls"><button type="button" className="ghost-button" onClick={() => setCurrentPage((page) => page - 1)} disabled={currentPage === 0}>Previous</button><span aria-live="polite">Page {currentPage + 1} of {pageCount}</span><button type="button" className="ghost-button" onClick={() => setCurrentPage((page) => page + 1)} disabled={currentPage === pageCount - 1}>Next</button></div></nav>}
      <div className="table-head travel-order-list-head"><span>Departure Return Date</span><span>Place of Travel</span><span>Purpose</span><span>Prepared By</span><span>Status</span></div>
      {visibleOrders.map((order) => {
        const isOwner = order.ownerId === ownerId;
        const groupOrders = isOwner
          ? [...(ownerOrderGroups.get(travelOrderGroupKey(order)) ?? [order])].sort((left, right) => (left.travelOrderPersonIndex ?? Number.MAX_SAFE_INTEGER) - (right.travelOrderPersonIndex ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id))
          : [order];
        const groupApprovalPeople = travelOrderApprovalPeople(groupOrders);
        const isRecipient = isAssignedTravelOrderRecipient(order, ownerId);
        const canUpdateStatus = isOwner || isRecipient;
        const canApprove = isOwner || (isRecipient && canRecipientApproveTravelOrder(order));
        return <div className="travel-order-row-group" key={order.id}>
        <div className="table-row travel-order-list-row">
          <strong data-label="Travel dates">{formatTravelDateRange(order.departureDate, order.returnDate) || (order.status === "Pending" ? "Pending approval" : "—")}</strong><span data-label="Place of Travel">{order.placeOfTravel || "—"}</span><span data-label="Purpose" className="travel-order-list-purpose">{order.purpose || "—"}</span><span data-label="Prepared By">{preparedByNames[order.preparedById ?? order.ownerId] || ((order.preparedById ?? order.ownerId) === ownerId ? fallbackPreparedBy : "") || "—"}</span>
          {canUpdateStatus ? <label data-label="Status" className={`travel-order-status travel-order-status-${order.status.toLowerCase()}`}><span className="sr-only">Status</span><select className="status-select" data-status={order.status} aria-label={`Status for ${order.people[0]?.name || "Travel Order"}`} value={order.status} disabled={order.status !== "Pending" || updatingId === order.id || deletingId !== null || copyingId !== null} onChange={(event) => { const nextStatus = event.target.value as TravelOrderStatus; if (nextStatus === "Approved") { if (!canApprove) return; const approvalPeople = travelOrderApprovalPeople(groupOrders); setApprovalOrderId(order.id); setApprovalDates(approvalPeople.map(({ pageOrder }) => pageOrder.status === "Pending" ? "" : pageOrder.date ?? "")); setApprovalNumbers(approvalPeople.map(({ person }) => person.toNumber ?? "")); } else { setApprovalOrderId(null); void onStatusChange(order, nextStatus); } }}>{statuses.map((status) => <option key={status} disabled={status === "Approved" && !canApprove}>{status}</option>)}</select>{updatingId === order.id && <small>Saving...</small>}</label> : <span data-label="Status" className={`travel-order-status travel-order-status-${order.status.toLowerCase()}`}><span className="travel-order-status-value">{order.status}</span></span>}
          <span className="travel-order-row-actions">{isOwner && order.status === "Pending" && <button type="button" className="row-action" disabled={updatingId !== null || deletingId !== null || copyingId !== null} onClick={() => onEdit(order)}>Edit</button>}<button type="button" className="row-action" disabled={deletingId !== null} onClick={() => onPreview(isOwner ? { ...order, previewPageOrders: groupOrders } : order)}>View</button><button type="button" className="row-action" disabled={updatingId !== null || deletingId !== null || copyingId !== null || approvalOrderId !== null} onClick={() => onCopy(order)}>{copyingId === order.id ? "Copying..." : "Copy"}</button>{isOwner && order.status === "Pending" && <button type="button" className="delete-button" disabled={updatingId !== null || deletingId !== null || copyingId !== null} onClick={() => onDelete(order)}>{deletingId === order.id ? "Deleting..." : "Delete"}</button>}</span>
        </div>
        {approvalOrderId === order.id && <div className="travel-order-approval-editor">
          <div><strong>Complete your Travel Order</strong><p>Update each personnel row independently. Date and TO No. are optional.</p></div>
          <div className="travel-order-approval-person-rows">{groupApprovalPeople.map(({ pageOrder, person, personIndex, index }) => <div className="travel-order-approval-person-row" key={`${pageOrder.id}-approval-${personIndex}`}>
            <label>Date<input type="date" value={approvalDates[index] ?? ""} onChange={(event) => updateApprovalDate(index, event.target.value)} disabled={pageOrder.status !== "Pending" || updatingId !== null} /></label>
            <label>TO No.<input value={approvalNumbers[index] ?? ""} onChange={(event) => updateApprovalNumber(index, event.target.value)} disabled={pageOrder.status !== "Pending" || updatingId !== null} /></label>
            <strong>{person.name}</strong>
            {pageOrder.status === "Pending" ? <button type="button" className="primary-button" disabled={updatingId !== null || deletingId !== null} onClick={() => void updateApprovedPerson(pageOrder, personIndex, groupOrders)}>{updatingId === pageOrder.id ? "Updating..." : "Update"}</button> : <span className="travel-order-approval-complete">Approved</span>}
          </div>)}</div>
          <div className="travel-order-number-actions"><button type="button" className="ghost-button" disabled={updatingId !== null || deletingId !== null} onClick={() => setApprovalOrderId(null)}>Close</button></div>
        </div>}
        </div>;
      })}
    </div>}
  </section>;
}
function TravelField({ label, children = "", className = "" }: { label: string; children?: string; className?: string }) {
  return <div className={`travel-order-field ${className}`}><strong>{label}:</strong><span className="travel-order-value">{children || "\u00a0"}</span></div>;
}

function TravelOrderPaper({ order, person, role, office, division, unit }: { order: TravelOrder; person: TravelOrderPerson; role: string; office: string; division: string; unit: string | null }) {
  const isAdministrativeFinanceRegularUser = role === "regular"
    && office === "Division"
    && division === "Administrative and Finance Division"
    && ["General Services Section", "Human Resource Section", "Administrative and Finance Division"].includes(unit ?? "");
  const isAdministrativeFinanceAdminUser = role === "admin"
    && office === "Division"
    && division === "Administrative and Finance Division"
    && ["General Services Section", "Human Resource Section"].includes(unit ?? "");
  const recommendingSignatory = isAdministrativeFinanceRegularUser || isAdministrativeFinanceAdminUser
    ? getDivisionSignatory("Administrative and Finance Division")
    : { name: "REBECCA R. ATEGA", position: "RTD for Operations" };
  const recommendingPosition = isAdministrativeFinanceAdminUser
    ? "Acting Supervising Administrative Officer"
    : recommendingSignatory.position === "OIC"
      ? "OIC, Administrative and Finance Division"
      : recommendingSignatory.position;
  return <article className="travel-order-paper">
    <div className="travel-order-frame" />
    <img className="travel-order-letterhead" src={asset("/Travel%20Order%20-%20header.jpg")} alt="Department of Agriculture Caraga Region letterhead" />
    <div className="travel-order-document">
      <div className="travel-order-header-divider" aria-hidden="true" />
      <h1>TRAVEL ORDER</h1>
      <div className="travel-order-number-date"><TravelField label="No.">{person.toNumber ?? ""}</TravelField> <TravelField label="Date" className="travel-order-date-field">{formatTravelDate(order.date)}</TravelField></div>
      <div className="travel-order-person-fields">
        <div><TravelField label="Name">{person.name}</TravelField><TravelField label="Position">{person.position}</TravelField></div>
        <div><TravelField label="Salary Per Month">{formatTravelSalary(person.salary)}</TravelField><TravelField label="Office Station">{order.officeStation}</TravelField></div>
      </div>
      <div className="travel-order-date-fields"><TravelField label="Departure Date">{formatTravelDate(order.departureDate)}</TravelField><TravelField label="Return Date">{formatTravelDate(order.returnDate)}</TravelField></div>
      <div className="travel-order-fields-stack">
        <TravelField label="Place of Travel">{order.placeOfTravel}</TravelField>
        <TravelField label="Specific Purpose of the Trip">{order.purpose}</TravelField>
        <TravelField label="Objective(s)">{order.objective}</TravelField>
        <TravelField label="Per Diems Allowed">{order.perDiemsAllowed}</TravelField>
        <TravelField label="Assistant Laborers Allowed">{order.assistantLaborersAllowed}</TravelField>
        <TravelField label="Appropriation to which travel should be charged">{order.chargeTo}</TravelField>
        <TravelField label="Means of Transportation">{order.transportation}</TravelField>
        <TravelField label="Remarks or Special Instructions">{order.remarks}</TravelField>
      </div>
      <div className="travel-order-approvals">
        <span>Recommending Approval:</span>
        <span>Approved:</span>
        <strong>{recommendingSignatory.name.toLocaleUpperCase("en-PH")}</strong>
        <strong>ENGR. RICARDO M. OÑATE JR.</strong>
        <em>{isAdministrativeFinanceAdminUser ? <>{recommendingPosition}<br /><span className="travel-order-position-division">Administrative and Finance Division</span></> : recommendingSignatory.position === "OIC" ? <>OIC, <span className="travel-order-position-division">Administrative and Finance Division</span></> : recommendingPosition}</em>
        <em>Regional Executive Director</em>
      </div>
      <table className="travel-order-certification"><thead><tr><th>Date</th><th>Place of Visited</th><th>Purpose</th><th>Certifying Officer</th></tr></thead><tbody><tr><td /><td /><td>{order.purpose}</td><td /></tr></tbody></table>
    </div>
    {order.status === "Disapproved" && <div className="travel-order-disapproved-stamp" aria-label="Disapproved">DISAPPROVED</div>}
  </article>;
}

function TravelOrderPreview({ order, role, office, division, unit, onClose }: { order: TravelOrder; role: string; office: string; division: string; unit: string | null; onClose: () => void }) {
  const pagesRef = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState("");
  const pageOrders = order.previewPageOrders?.length ? order.previewPageOrders : [order];
  const pageCount = pageOrders.reduce((total, pageOrder) => total + pageOrder.people.length, 0);

  async function downloadPdf() {
    if (!pagesRef.current) return;
    setDownloading(true);
    setError("");
    try {
      const { html2canvas, jsPDF } = await loadPdfTools();
      await Promise.all(Array.from(pagesRef.current.querySelectorAll("img")).map(async (image) => {
        if (!image.complete) await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("The Travel Order header image could not be loaded.")); });
        if (image.naturalWidth === 0) throw new Error("The Travel Order header image could not be loaded.");
        if (image.decode) await image.decode();
      }));
      const pages = Array.from(pagesRef.current.querySelectorAll<HTMLElement>(".travel-order-paper"));
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      for (let index = 0; index < pages.length; index += 1) {
        const canvas = await html2canvas(pages[index], { backgroundColor: "#fff", logging: false, scale: 3, useCORS: true });
        if (index > 0) pdf.addPage();
        pdf.addImage(canvas.toDataURL("image/jpeg", .96), "JPEG", 0, 0, 210, 297);
      }
      pdf.save(`travel-order-${order.id}.pdf`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to create the Travel Order PDF."); }
    finally { setDownloading(false); }
  }

  async function printPreview() {
    if (!pagesRef.current) return;
    setPrinting(true);
    setPrintError("");
    try {
      await Promise.all(Array.from(pagesRef.current.querySelectorAll("img")).map(async (image) => {
        if (!image.complete) await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error("The Travel Order header image could not be loaded."));
        });
        if (image.naturalWidth === 0) throw new Error("The Travel Order header image could not be loaded.");
        if (image.decode) await image.decode();
      }));
      if (document.fonts?.ready) await document.fonts.ready;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      window.print();
    } catch (cause) {
      setPrintError(cause instanceof Error ? cause.message : "Unable to prepare the Travel Order for printing.");
    } finally {
      setPrinting(false);
    }
  }

  return <div className="preview-backdrop travel-order-preview-backdrop"><div className="preview-toolbar"><span>Travel Order preview · {pageCount} {pageCount === 1 ? "page" : "pages"}</span><button type="button" className="ghost-button" onClick={onClose}>Close</button><button type="button" className="pdf-button" disabled={downloading} onClick={downloadPdf}>{downloading ? "Preparing PDF..." : "Download PDF"}</button><button type="button" className="pdf-button" disabled={printing} onClick={printPreview}>{printing ? "Preparing print..." : "Print"}</button>{error && <small className="download-error">{error}</small>}{printError && <small className="download-error" role="alert">{printError}</small>}</div><div ref={pagesRef} className="travel-order-preview-pages">{pageOrders.flatMap((pageOrder) => pageOrder.people.map((person, index) => <TravelOrderPaper key={`${pageOrder.id}-${index}`} order={pageOrder} person={person} role={role} office={office} division={division} unit={unit} />))}</div></div>;
}

export default function TravelOrderModule({ user, role, office, division, unit, focusRecordId, onFocusHandled, onPreviewClose }: { user: User; role: string; office: string; division: string; unit: string | null; focusRecordId?: string; onFocusHandled?: () => void; onPreviewClose?: () => void }) {
  const [orders, setOrders] = useState<TravelOrder[]>([]);
  const [preparedByNames, setPreparedByNames] = useState<Record<string, string>>({});
  const preparedByNameLookup = useRef(new Set<string>());
  const [view, setView] = useState<"list" | "new">("list");
  const [editingOrder, setEditingOrder] = useState<TravelOrder | null>(null);
  const [preview, setPreview] = useState<TravelOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TravelOrder | null>(null);
  const [error, setError] = useState("");
  const handledFocusIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!db) { setLoading(false); setError("Firebase is not configured."); return; }
    setLoading(true);
    const firestore = db;
    let ownerRowsCache: TravelOrder[] = [];
    let recipientRowsCache: TravelOrder[] = [];

    function publishRows() {
      const byId = new Map<string, TravelOrder>();
      [...ownerRowsCache, ...recipientRowsCache].forEach((order) => byId.set(order.id, order));
      const rows = [...byId.values()];
      const splitSources = new Set(rows.map((order) => order.splitFromOrderId).filter((id): id is string => Boolean(id)));
      const visibleRows = rows.filter((order) => !(splitSources.has(order.id) && (order.people.length !== 1 || !order.recipientId)));
      visibleRows.sort((left, right) => ((right.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0) - ((left.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0));
      setOrders(visibleRows);
    }

    async function loadOrders() {
      const loadSnapshots = () => Promise.all([
        getDocs(query(collection(firestore, "travelOrders"), where("ownerId", "==", user.uid))),
        getDocs(query(collection(firestore, "travelOrders"), where("recipientId", "==", user.uid))),
      ]);
      let [ownerSnapshot, recipientSnapshot] = await loadSnapshots();
      const initialRows = [
        ...ownerSnapshot.docs.map((item) => ({ id: item.id, ...item.data() } as TravelOrder)),
        ...recipientSnapshot.docs.map((item) => ({ id: item.id, ...item.data() } as TravelOrder)),
      ];
      const splitSources = new Set(initialRows.map((order) => order.splitFromOrderId).filter((id): id is string => Boolean(id)));
      const legacyOrders = ownerSnapshot.docs
        .map((item) => ({ id: item.id, ...item.data() } as TravelOrder))
        .filter((order) => !splitSources.has(order.id)
          && Array.isArray(order.people)
          && order.people.length > 0
          && (order.people.length !== 1 || !order.recipientId || order.recipientIds?.length !== 1 || order.people[0].userId !== order.recipientId)
          && order.people.every((person) => Boolean(person.userId)));

      if (unit) {
        let migratedLegacyOrder = false;
        for (const order of legacyOrders) {
          try {
            const notificationReferences = await getDocumentNotificationReferences(firestore, user.uid, order.id);
            const batch = writeBatch(firestore);
            notificationReferences.forEach((reference) => batch.delete(reference));
            if (order.status === "Pending") batch.delete(doc(firestore, "travelOrders", order.id));
            const { id: _sourceId, ...sourceData } = order;
            for (const [personIndex, person] of order.people.entries()) {
              const recipientId = person.userId!;
              const personalOrderId = `${encodeURIComponent(order.id)}_${personIndex}_${encodeURIComponent(recipientId)}`;
              const orderRef = doc(firestore, "travelOrders", personalOrderId);
              const personalRecord = {
                ...sourceData,
                people: [person],
                status: normalizeWorkflowStatus(order.status),
                ownerUnit: unit,
                travelOrderGroupId: order.travelOrderGroupId ?? order.id,
                travelOrderPersonIndex: personIndex,
                recipientId,
                recipientIds: [recipientId],
                splitFromOrderId: order.id,
              };
              batch.set(orderRef, personalRecord);
              if (recipientId !== user.uid) {
                const notification = makeDocumentNotification(firestore, { recipientId, ownerId: user.uid, documentId: orderRef.id, documentType: "Travel Order", departureDate: order.departureDate, returnDate: order.returnDate, placeOfTravel: order.placeOfTravel, purpose: order.purpose });
                batch.set(notification.reference, notification.data);
              }
            }
            await batch.commit();
            migratedLegacyOrder = true;
          } catch (cause) {
            console.warn("Could not split a legacy Travel Order; keeping the original order visible.", cause);
          }
        }
        if (migratedLegacyOrder) [ownerSnapshot, recipientSnapshot] = await loadSnapshots();
      }

      ownerRowsCache = ownerSnapshot.docs.map((item) => ({ id: item.id, ...item.data(), status: normalizeWorkflowStatus(item.data().status) } as TravelOrder));
      recipientRowsCache = recipientSnapshot.docs.map((item) => ({ id: item.id, ...item.data(), status: normalizeWorkflowStatus(item.data().status) } as TravelOrder));
      publishRows();

      const ownerIds = [...new Set([user.uid, ...[...ownerRowsCache, ...recipientRowsCache].map((row) => row.preparedById ?? row.ownerId)])];
      const ownerProfiles = await Promise.all(ownerIds.map(async (ownerId) => {
        try {
          const profile = await getDoc(doc(firestore, "users", ownerId));
          const name = profile.exists() && typeof profile.data().name === "string" ? profile.data().name.trim() : "";
          return [ownerId, name] as const;
        } catch {
          return [ownerId, ""] as const;
        }
      }));
      preparedByNameLookup.current = new Set(ownerIds);
      setPreparedByNames(Object.fromEntries(ownerProfiles));
    }

    let unsubscribeRecipient: (() => void) | undefined;
    let cancelled = false;
    loadOrders().then(() => {
      if (cancelled) return;
      unsubscribeRecipient = onSnapshot(query(collection(firestore, "travelOrders"), where("recipientId", "==", user.uid)), (snapshot) => {
        recipientRowsCache = snapshot.docs.map((item) => ({ id: item.id, ...item.data(), status: normalizeWorkflowStatus(item.data().status) } as TravelOrder));
        const missingOwnerIds = [...new Set(recipientRowsCache.map((order) => order.preparedById ?? order.ownerId))]
          .filter((ownerId) => !preparedByNameLookup.current.has(ownerId));
        missingOwnerIds.forEach((ownerId) => preparedByNameLookup.current.add(ownerId));
        if (missingOwnerIds.length) {
          void Promise.all(missingOwnerIds.map(async (ownerId) => {
            try {
              const profile = await getDoc(doc(firestore, "users", ownerId));
              const name = profile.exists() && typeof profile.data().name === "string" ? profile.data().name.trim() : "";
              return [ownerId, name] as const;
            } catch {
              return [ownerId, ""] as const;
            }
          })).then((profiles) => setPreparedByNames((current) => ({ ...current, ...Object.fromEntries(profiles) })));
        }
        publishRows();
      }, (cause) => {
        const code = (cause as { code?: string }).code;
        setError(code ? `Could not load assigned Travel Orders (${code}).` : "Could not load assigned Travel Orders.");
      });
    }).catch((cause) => {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not load Travel Orders (${code}).` : "Could not load Travel Orders. Refresh and try again.");
    }).finally(() => setLoading(false));
    return () => {
      cancelled = true;
      unsubscribeRecipient?.();
    };
  }, [user.uid, unit]);
  useEffect(() => {
    if (!focusRecordId) { handledFocusIdRef.current = null; return; }
    if (handledFocusIdRef.current === focusRecordId || loading) return;
    const order = orders.find((item) => item.id === focusRecordId);
    if (!order) return;
    handledFocusIdRef.current = focusRecordId;
    setPreview(withOwnerTravelOrderPages(order, orders, user.uid));
    onFocusHandled?.();
  }, [focusRecordId, loading, onFocusHandled, orders]);

  async function deleteOrder(order: TravelOrder) {
    const firestore = db;
    if (!firestore || order.ownerId !== user.uid) return;
    if (order.status !== "Pending") {
      setError("Approved or Disapproved Travel Orders cannot be deleted.");
      setPendingDelete(null);
      return;
    }
    setDeletingId(order.id);
    setError("");
    try {
      const numberRefs = [...new Set(order.people.map((person) => person.toNumber?.trim()).filter((number): number is string => Boolean(number)))]
        .map((number) => doc(firestore, "travelOrderNumbers", travelOrderNumberKey(number)));
      const numberSnapshots = await Promise.all(numberRefs.map((numberRef) => getDoc(numberRef)));
      const notificationReferences = await getDocumentNotificationReferences(firestore, user.uid, order.id);
      const batch = writeBatch(firestore);
      numberSnapshots.forEach((snapshot) => {
        if (!snapshot.exists()) return;
        const data = snapshot.data();
        if (data.ownerId === user.uid && data.travelOrderId === order.id) batch.delete(snapshot.ref);
      });
      notificationReferences.forEach((reference) => batch.delete(reference));
      batch.delete(doc(firestore, "travelOrders", order.id));
      await batch.commit();
      setOrders((current) => current.filter((item) => item.id !== order.id));
      setPreview((current) => current?.id === order.id ? null : current);
      setPendingDelete(null);
      setEditingOrder((current) => current?.id === order.id ? null : current);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not delete Travel Order (${code}).` : "Could not delete Travel Order.");
      setPendingDelete(null);
    } finally {
      setDeletingId(null);
    }
  }

  async function copyOrder(order: TravelOrder) {
    const firestore = db;
    if (!firestore) return;
    if (!unit) { setError("Your Unit / Program / Project is still loading. Try copying again in a moment."); return; }
    if (!order.people.length || order.people.some((person) => !person.userId)) {
      setError("This older Travel Order has no account assigned to every person. Edit it and select an account for each person before copying.");
      return;
    }
    setCopyingId(order.id);
    setError("");
    try {
      const people = order.people.map((person) => {
        const copyPerson = { ...person };
        delete copyPerson.toNumber;
        return copyPerson;
      });
      const record = {
        date: "",
        officeStation: order.officeStation,
        departureDate: order.departureDate,
        returnDate: order.returnDate,
        placeOfTravel: order.placeOfTravel,
        purpose: order.purpose,
        objective: order.objective,
        perDiemsAllowed: order.perDiemsAllowed,
        assistantLaborersAllowed: order.assistantLaborersAllowed,
        chargeTo: order.chargeTo,
        transportation: order.transportation,
        remarks: order.remarks,
        status: "Pending" as const,
        ownerId: user.uid,
        ownerUnit: unit,
      };
      const batch = writeBatch(firestore);
      const copies: TravelOrder[] = [];
      const travelOrderGroupId = doc(collection(firestore, "travelOrders")).id;
      for (const [personIndex, person] of people.entries()) {
        const recipientId = person.userId!;
        const orderRef = doc(collection(firestore, "travelOrders"));
        const personalRecord = { ...record, people: [person], travelOrderGroupId, travelOrderPersonIndex: personIndex, recipientId, recipientIds: [recipientId], createdAt: serverTimestamp() };
        batch.set(orderRef, personalRecord);
        if (recipientId !== user.uid) {
          const notification = makeDocumentNotification(firestore, { recipientId, ownerId: user.uid, documentId: orderRef.id, documentType: "Travel Order", departureDate: record.departureDate, returnDate: record.returnDate, placeOfTravel: record.placeOfTravel, purpose: record.purpose });
          batch.set(notification.reference, notification.data);
        }
        copies.push({ id: orderRef.id, ...personalRecord });
      }
      await batch.commit();
      setOrders((current) => [...copies, ...current]);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not copy Travel Order (${code}).` : "Could not copy Travel Order.");
    } finally {
      setCopyingId(null);
    }
  }

  async function changeStatus(order: TravelOrder, status: TravelOrderStatus, date?: string, toNumbers?: string[], pageOrders?: TravelOrder[]): Promise<boolean> {
    const isOwner = order.ownerId === user.uid;
    const isRecipient = isAssignedTravelOrderRecipient(order, user.uid);
    if (!isOwner && !isRecipient) return false;
    if (order.status !== "Pending") {
      setError("Approved or Disapproved Travel Orders cannot change status.");
      return false;
    }
    if (status === "Approved" && !isOwner && !canRecipientApproveTravelOrder(order)) {
      setError("A multi-person Travel Order can only be approved by its original maker.");
      return false;
    }
    const firestore = db;
    if (!firestore) { setError("Firebase is not configured."); return false; }
    setUpdatingId(order.id);
    setError("");
    try {
      if (status === "Approved") {
        const targetOrders = isOwner ? (pageOrders?.length ? pageOrders : [order]) : [order];
        const uniqueTargetOrders = [...new Map(targetOrders.map((targetOrder) => [targetOrder.id, targetOrder])).values()];
        const groupKey = travelOrderGroupKey(order);
        if (!uniqueTargetOrders.some((targetOrder) => targetOrder.id === order.id)
          || uniqueTargetOrders.some((targetOrder) => targetOrder.ownerId !== order.ownerId || travelOrderGroupKey(targetOrder) !== groupKey)) {
          setError("Could not identify every person in this Travel Order.");
          return false;
        }
        const approvalPeople = travelOrderApprovalPeople(uniqueTargetOrders);
        if (toNumbers && toNumbers.length !== approvalPeople.length) {
          setError("The TO No. fields do not match this Travel Order.");
          return false;
        }
        const numbers = approvalPeople.map((entry, index) => (toNumbers?.[index] ?? entry.person.toNumber ?? "").trim());
        const numberEntries = numbers.map((number, index) => ({ number, index })).filter(({ number }) => Boolean(number));
        const normalizedNumbers = numberEntries.map(({ number }) => number.toUpperCase());
        if (new Set(normalizedNumbers).size !== normalizedNumbers.length) {
          setError("Each person must have a different TO No.");
          return false;
        }

        let personIndex = 0;
        const approvalRecords = uniqueTargetOrders.map((targetOrder) => ({
          order: targetOrder,
          people: targetOrder.people.map((person) => ({ ...person, toNumber: numbers[personIndex++] })),
        }));
        const requestedNumberEntries = numberEntries.map(({ number, index }) => ({ key: travelOrderNumberKey(number), travelOrderId: approvalPeople[index].pageOrder.id }));
        const existingNumberEntries = [...new Map(approvalPeople.map(({ person, pageOrder }) => ({ number: person.toNumber?.trim() ?? "", travelOrderId: pageOrder.id }))
          .filter(({ number }) => Boolean(number))
          .map(({ number, travelOrderId }) => {
            const key = travelOrderNumberKey(number);
            return [key, { key, travelOrderId }] as const;
          })).values()];
        const travelOrderRefs = approvalRecords.map(({ order: targetOrder }) => doc(firestore, "travelOrders", targetOrder.id));
        const numberRefsByKey = new Map([...requestedNumberEntries, ...existingNumberEntries].map(({ key }) => [key, doc(firestore, "travelOrderNumbers", key)]));
        const numberKeys = [...numberRefsByKey.keys()];
        const numberRefs = numberKeys.map((key) => numberRefsByKey.get(key)!);
        await runTransaction(firestore, async (transaction) => {
          const snapshots = await Promise.all([...travelOrderRefs, ...numberRefs].map((reference) => transaction.get(reference)));
          const orderSnapshots = snapshots.slice(0, travelOrderRefs.length);
          const registeredNumberSnapshots = snapshots.slice(travelOrderRefs.length);
          const registeredNumbersByKey = new Map(numberKeys.map((key, index) => [key, registeredNumberSnapshots[index]]));
          if (orderSnapshots.some((snapshot) => !snapshot.exists())) throw new Error("A Travel Order in this group is no longer available.");
          const currentOrders = orderSnapshots.map((snapshot) => ({ id: snapshot.id, ...(snapshot.data() ?? {}) } as TravelOrder));
          if (currentOrders.some((currentOrder) => (isOwner && currentOrder.ownerId !== user.uid)
            || (!isOwner && currentOrder.recipientId !== user.uid)
            || travelOrderGroupKey(currentOrder) !== groupKey
            || normalizeWorkflowStatus(currentOrder.status) !== "Pending")) {
            throw new Error("A Travel Order in this group is no longer pending approval.");
          }
          if (requestedNumberEntries.some(({ key, travelOrderId }) => {
            const snapshot = registeredNumbersByKey.get(key);
            return snapshot?.exists() && (snapshot.data().ownerId !== user.uid || snapshot.data().travelOrderId !== travelOrderId);
          })) {
            throw new Error("This TO No. is already assigned to another Travel Order.");
          }
          approvalRecords.forEach(({ people }, index) => {
            transaction.update(travelOrderRefs[index], { status, date: date?.trim() ?? "", people, updatedAt: serverTimestamp() });
          });
          existingNumberEntries.forEach(({ key, travelOrderId }) => {
            const snapshot = registeredNumbersByKey.get(key);
            if (!requestedNumberEntries.some((entry) => entry.key === key) && snapshot?.exists()
              && snapshot.data().ownerId === user.uid && snapshot.data().travelOrderId === travelOrderId) {
              transaction.delete(numberRefsByKey.get(key)!);
            }
          });
          requestedNumberEntries.forEach(({ key, travelOrderId }) => {
            if (!registeredNumbersByKey.get(key)?.exists()) transaction.set(numberRefsByKey.get(key)!, { ownerId: user.uid, travelOrderId });
          });
        });
        const updatedOrders = new Map(approvalRecords.map(({ order: targetOrder, people }) => [targetOrder.id, { ...targetOrder, status, date: date?.trim() ?? "", people }]));
        setOrders((current) => current.map((item) => updatedOrders.get(item.id) ?? item));
      } else {
        await updateDoc(doc(firestore, "travelOrders", order.id), { status, updatedAt: serverTimestamp() });
        setOrders((current) => current.map((item) => item.id === order.id ? { ...item, status } : item));
      }
      return true;
    } catch (cause) {
      if (cause instanceof Error && (cause.message === "This TO No. is already assigned to another Travel Order."
        || cause.message === "A Travel Order in this group is no longer available."
        || cause.message === "A Travel Order in this group is no longer pending approval.")) {
        setError(cause.message);
      } else {
        const code = (cause as { code?: string }).code;
        setError(code ? `Could not update Travel Order status (${code}).` : "Could not update Travel Order status.");
      }
      return false;
    } finally { setUpdatingId(null); }
  }

  function closePreview() { setPreview(null); onPreviewClose?.(); }

  return <>
    {error && <div className="error-message travel-order-error">{error}</div>}
    {editingOrder ? <TravelOrderForm key={editingOrder.id} user={user} office={office} division={division} unit={unit} initialOrder={editingOrder} onSaved={(savedOrders, replacedOrderId) => { setOrders((current) => mergeSavedTravelOrders(current, savedOrders, replacedOrderId)); setEditingOrder(null); }} onCancel={() => setEditingOrder(null)} onError={setError} /> : view === "new" ? <TravelOrderForm user={user} office={office} division={division} unit={unit} onSaved={(savedOrders) => { setOrders((current) => mergeSavedTravelOrders(current, savedOrders)); setView("list"); }} onCancel={() => setView("list")} onError={setError} /> : loading ? <section className="content-section"><p className="muted">Loading Travel Orders...</p></section> : <TravelOrderList orders={orders} ownerId={user.uid} preparedByNames={preparedByNames} fallbackPreparedBy={user.displayName ?? ""} onNew={() => { setError(""); setView("new"); }} onEdit={(order) => { setError(""); setEditingOrder(order); }} onPreview={(order) => setPreview(withOwnerTravelOrderPages(order, orders, user.uid))} onCopy={(order) => void copyOrder(order)} onDelete={setPendingDelete} onStatusChange={changeStatus} updatingId={updatingId} deletingId={deletingId} copyingId={copyingId} />}
    <DeleteConfirmation open={Boolean(pendingDelete && pendingDelete.ownerId === user.uid)} title="Confirm Travel Order Deletion?" description="Are you sure you want to delete this Travel Order? This action cannot be undone. Its assigned TO No. values will be released." busy={Boolean(pendingDelete && deletingId === pendingDelete.id)} onCancel={() => setPendingDelete(null)} onConfirm={() => { if (pendingDelete) void deleteOrder(pendingDelete); }} />
    {preview && <TravelOrderPreview order={preview} role={role} office={office} division={division} unit={unit} onClose={closePreview} />}
  </>;
}
