import type { CSSProperties } from "react";
import {
  cenrrRows,
  chargedToForUnit,
  defaultTevCertificationOfTravel,
  displayTevTransportationMeans,
  divisionSignatory,
  formatTevAmount,
  formatTevDate,
  formatTevDateRange,
  formatTevTime,
  formatTevTravelDateRanges,
  formatTevTravelReferences,
  maxCenrrRows,
  maxItineraryRows,
  tevDivisionLabel,
  tevCtcDirector,
  tevCtcDirectorOffice,
  tevDvAccountingSignatory,
  tevDvApprovingSignatory,
  tevEntityName,
  tevFundCluster,
  tevOrsBudgetSignatory,
  tevOrsOffice,
  tevOrsOfficeAddress,
  tevPurpose,
  totalsForItinerary,
  totalsForRecord,
  perDiemForClaims,
  transportationForRow,
  type MyTevRecord,
  type TevItinerary,
  type TevItineraryRow,
  type TevRegionRate,
} from "@/lib/mytev";

const publicAsset = (path: string) => `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`;
const daCaragaLogo = publicAsset("/da-caraga-logo.jpg");
function monthLabel(value: string) {
  if (!/^\d{4}-\d{2}$/.test(value)) return value;
  return new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}-01T00:00:00Z`));
}

function hasItineraryData(row: TevItineraryRow) {
  return Boolean(row.dateFrom || row.dateTo || row.visitedPlaces || row.departureTimeFrom || row.departureTimeTo || row.meansOfTransportation);
}

function formatTevAmountIfNonZero(value: number) {
  return value === 0 ? "" : formatTevAmount(value);
}

type DocumentRowPage<T> = { rows: T[]; heights: number[]; usedHeight: number };

function paginateRows<T>(rows: T[], maxRows: number, maxHeight: number, minRowHeight: number, estimateHeight: (row: T) => number): DocumentRowPage<T>[] {
  const pages: DocumentRowPage<T>[] = [];
  let page: DocumentRowPage<T> = { rows: [], heights: [], usedHeight: 0 };
  for (const row of rows) {
    const height = Math.max(minRowHeight, estimateHeight(row));
    if (page.rows.length && (page.rows.length >= maxRows || page.usedHeight + height > maxHeight)) {
      pages.push(page);
      page = { rows: [], heights: [], usedHeight: 0 };
    }
    page.rows.push(row);
    page.heights.push(height);
    page.usedHeight += height;
  }
  if (page.rows.length || pages.length === 0) pages.push(page);
  return pages;
}

function estimateTextHeight(value: string, charactersPerLine: number, lineHeight: number, minimum: number) {
  return Math.max(minimum, Math.ceil(value.length / charactersPerLine) * lineHeight + 1);
}

function itineraryRowHeight(row: TevItineraryRow) {
  return Math.max(
    7,
    estimateTextHeight(row.visitedPlaces, 32, 3.2, 7),
    estimateTextHeight(formatTevDateRange(row.dateFrom, row.dateTo), 19, 3.2, 7),
    estimateTextHeight(row.meansOfTransportation, 13, 3.2, 7),
  );
}

function cenrrRowHeight(row: ReturnType<typeof cenrrRows>[number]) {
  return Math.max(
    4.2,
    estimateTextHeight(formatTevDateRange(row.dateFrom, row.dateTo), 19, 3.1, 4.2),
    estimateTextHeight(row.visitedPlaces, 39, 3.1, 4.2),
    estimateTextHeight(row.meansOfTransportation, 20, 3.1, 4.2),
  );
}

function pageRowsWithFillers<T>(page: DocumentRowPage<T>, maxRows: number, maxHeight: number, minRowHeight: number) {
  const spareRows = Math.floor(Math.max(0, maxHeight - page.usedHeight) / minRowHeight);
  const fillerCount = Math.min(maxRows - page.rows.length, spareRows);
  return [
    ...page.rows.map((row, index) => ({ row, height: page.heights[index] })),
    ...Array.from({ length: fillerCount }, () => ({ row: undefined, height: minRowHeight })),
  ];
}

function fitScale(value: string, comfortableCharacters: number, minimumScale = 0.68) {
  return Math.max(minimumScale, Math.min(1, comfortableCharacters / Math.max(value.length, comfortableCharacters)));
}

function fitTextStyle(value: string, comfortableCharacters: number, fontVariable = "--mytev-font-12", fontMultiplier = 1): CSSProperties {
  return {
    fontSize: `calc(var(${fontVariable}) * ${fontMultiplier} * ${fitScale(value, comfortableCharacters)})`,
    minWidth: 0,
    overflowWrap: "anywhere",
    whiteSpace: "normal",
  };
}

function itineraryDateRowSpan(rows: Array<TevItineraryRow | undefined>, index: number) {
  const row = rows[index];
  if (!row || (!row.dateFrom && !row.dateTo)) return 1;
  let span = 1;
  for (let next = index + 1; next < rows.length; next += 1) {
    const nextRow = rows[next];
    if (!nextRow || (!nextRow.dateFrom && !nextRow.dateTo) || nextRow.dateFrom !== row.dateFrom || nextRow.dateTo !== row.dateTo) break;
    span += 1;
  }
  return span;
}

function cenrrDateRowSpan(rows: Array<ReturnType<typeof cenrrRows>[number] | undefined>, index: number) {
  const row = rows[index];
  if (!row || (!row.dateFrom && !row.dateTo)) return 1;
  let span = 1;
  for (let next = index + 1; next < rows.length; next += 1) {
    const nextRow = rows[next];
    if (!nextRow || (!nextRow.dateFrom && !nextRow.dateTo) || nextRow.dateFrom !== row.dateFrom || nextRow.dateTo !== row.dateTo) break;
    span += 1;
  }
  return span;
}

function MyTevLetterhead({ appendix }: { appendix?: string }) {
  return <header className="mytev-letterhead">
    <img src={daCaragaLogo} alt="Department of Agriculture Caraga Region" />
    <div><span>Republic of the Philippines</span><strong>DEPARTMENT OF AGRICULTURE</strong><b>Caraga Region</b><span>Capitol Site, Butuan City</span><small>Tel. No.: (085) 817-9561; Telefax No.: (085) 818-6163</small></div>
    {appendix && <span className="mytev-appendix">{appendix}</span>}
  </header>;
}

function MyTevItineraryPage({ record, itinerary, page, pageNumber, documentPageNumber, isLastDocumentPage, recordTotals, rates }: { record: MyTevRecord; itinerary: TevItinerary; page: DocumentRowPage<TevItineraryRow>; pageNumber: number; documentPageNumber: number; isLastDocumentPage: boolean; recordTotals: ReturnType<typeof totalsForRecord>; rates: TevRegionRate[] }) {
  const profile = record.profile;
  const signatory = divisionSignatory(record.divisionName);
  const datesOfTravel = formatTevTravelDateRanges(record.travelReferences);
  const rows = pageRowsWithFillers(page, maxItineraryRows, 134, 7);
  const isContinuation = pageNumber > 1;
  const pageTotals = totalsForItinerary({ ...itinerary, rows: page.rows }, rates);
  const totals = isLastDocumentPage ? recordTotals : pageTotals;
  return <div className="mytev-paper-frame" key={itinerary.id}><article className="mytev-paper mytev-itinerary-paper">
    <div className="mytev-itinerary-document">
      <header className="mytev-itinerary-letterhead">
        <img src={daCaragaLogo} alt="Department of Agriculture Caraga Region" />
        <div><span>Republic of the Philippines</span><strong>DEPARTMENT OF AGRICULTURE</strong><b>Caraga Region</b><span>Capitol Site, Butuan City</span><small>Tel. No.: (085) 817-9561; Telefax No.: (085) 818-6163</small></div>
        <span className="mytev-itinerary-appendix">Appendix 45</span>
      </header>
      <h1 className="mytev-itinerary-title">ITINERARY OF TRAVEL{isContinuation ? " (CONTINUED)" : ""}</h1>
      <div className="mytev-itinerary-meta">
        <div className="mytev-itinerary-meta-basic">
          <div className="mytev-itinerary-meta-entity"><b>Entity Name:</b><span>{tevEntityName}</span></div>
          <div className="mytev-itinerary-meta-fund"><b>Fund Cluster:</b><span>{tevFundCluster}</span><b>No.:</b><span /></div>
        </div>
        <div className="mytev-itinerary-meta-details">
          <div><b>Name :</b><span style={fitTextStyle(profile.name, 45, "--mytev-font-15")}>{profile.name}</span><b>Date of Travel :</b><span style={fitTextStyle(datesOfTravel, 35, "--mytev-font-15", 1.5)}>{datesOfTravel}</span></div>
          <div><b>Position :</b><span style={fitTextStyle(profile.position, 42, "--mytev-font-15")}>{profile.position}</span><b>Purpose of Travel :</b><span><i>{tevPurpose}</i></span></div>
        </div>
      </div>
      <table className="mytev-itinerary-table">
        <colgroup><col /><col /><col /><col /><col /><col /><col /><col /><col /></colgroup>
        <thead>
          <tr className="mytev-itinerary-station"><th>Official Station :</th><td colSpan={8}>{record.officialStation}</td></tr>
          <tr><th rowSpan={2}>Date</th><th rowSpan={2}>Places to be visited<br />(Destination)</th><th colSpan={2}>T I M E</th><th rowSpan={2}>Means of<br />Transportation</th><th rowSpan={2}>Transportation</th><th rowSpan={2}>Per<br />Diem</th><th rowSpan={2}>Others</th><th rowSpan={2}>Total Amount</th></tr>
          <tr><th>Departure</th><th>Arrival</th></tr>
        </thead>
        <tbody>{rows.map(({ row, height }, index) => {
          const previous = rows[index - 1];
          const hasDate = Boolean(row && (row.dateFrom || row.dateTo));
          const sameDateAsPrevious = Boolean(hasDate && previous?.row && (previous.row.dateFrom || previous.row.dateTo) && previous.row.dateFrom === row?.dateFrom && previous.row.dateTo === row?.dateTo);
          return <tr key={`${itinerary.id}-line-${pageNumber}-${index}`} style={{ height: `${height}mm` }}>
          {!sameDateAsPrevious && <td className="mytev-itinerary-date" rowSpan={hasDate ? itineraryDateRowSpan(rows.map((item) => item.row), index) : 1}>{row ? formatTevDateRange(row.dateFrom, row.dateTo) : ""}</td>}
          <td>{row?.visitedPlaces}</td>
          <td className="mytev-itinerary-departure">{row ? formatTevTime(row.departureTimeFrom) : ""}</td>
          <td>{row ? formatTevTime(row.departureTimeTo) : ""}</td>
          <td>{row ? displayTevTransportationMeans(row.meansOfTransportation) : ""}</td>
          <td className="mytev-itinerary-transportation">{row ? formatTevAmountIfNonZero(transportationForRow(row)) : ""}</td>
          <td>{row ? formatTevAmountIfNonZero(perDiemForClaims(row.claims, row.region, rates)) : ""}</td>
          <td />
          <td>{row && hasItineraryData(row) ? formatTevAmountIfNonZero(perDiemForClaims(row.claims, row.region, rates) + transportationForRow(row)) : ""}</td>
        </tr>})}</tbody>
        {!isLastDocumentPage ? <tfoot><tr><td className="mytev-itinerary-total-label" colSpan={5}>SUBTOTAL</td><td>{formatTevAmountIfNonZero(pageTotals.transportation)}</td><td>{formatTevAmountIfNonZero(pageTotals.perDiem)}</td><td>-</td><td>{formatTevAmountIfNonZero(pageTotals.grandTotal)}</td></tr></tfoot> : <tfoot><tr><td className="mytev-itinerary-total-label" colSpan={5}>TOTAL</td><td>{formatTevAmountIfNonZero(totals.transportation)}</td><td>{formatTevAmountIfNonZero(totals.perDiem)}</td><td>-</td><td>{formatTevAmountIfNonZero(totals.grandTotal)}</td></tr></tfoot>}
      </table>
      <div className="mytev-itinerary-footer">
        <section className="mytev-itinerary-certified">
          <p className="mytev-itinerary-certification-text">I certify that (1) I have reviewed the foregoing itinerary; (2) the travel is necessary to the service; (3) the period covered is reasonable; and (4) the expenses claimed are proper.</p>
          <div className="mytev-itinerary-certified-signature"><strong>{signatory.name}</strong><small><i>{signatory.position}</i>, {tevDivisionLabel(record.divisionName)}</small></div>
        </section>
        <div className="mytev-itinerary-approvals">
          <section className="mytev-itinerary-prepared"><b>Prepared:</b><div><strong>{profile.name}</strong><small>{profile.position}</small></div></section>
          <section className="mytev-itinerary-approved"><b>Approved:</b><div><strong>REBECCA R. ATEGA</strong><small>RTD for Operations</small></div></section>
        </div>
      </div>
    </div>
  </article></div>;
}

function MyTevOrsPage({ record, rates }: { record: MyTevRecord; rates: TevRegionRate[] }) {
  const profile = record.profile;
  const signatory = divisionSignatory(record.divisionName);
  const [budgetTitle, budgetSection] = tevOrsBudgetSignatory.position.split(", ");
  const totals = totalsForRecord(record.itineraries, rates);
  return <div className="mytev-paper-frame"><article className="mytev-paper mytev-ors-paper">
    <div className="mytev-ors-document">
      <div className="mytev-ors-top"><MyTevLetterhead appendix="COA Circular 2015-002: Annex F" /></div>
      <div className="mytev-ors-title-row"><h1>OBLIGATION REQUEST AND STATUS</h1><div className="mytev-ors-number-fields"><span>Serial No.:</span><i /><span>Date:</span><i /><span>Fund Cluster:</span><b>{tevFundCluster}</b></div></div>
      <div className="mytev-ors-parties">
        <div><b>Payee</b><span style={fitTextStyle(profile.name, 65, "--mytev-font-11")}>{profile.name}</span></div>
        <div><b>Office</b><span>{tevOrsOffice}</span></div>
      </div>
      <div className="mytev-ors-payment"><b>FOR PAYMENT:</b><strong>{tevOrsOfficeAddress}</strong></div>
      <div className="mytev-ors-detail">
        <table><thead><tr><th>Responsibility Center</th><th>Particulars</th><th>MFO/PAP</th><th>UACS<br />Object<br />Code</th><th>Amount</th></tr></thead><tbody>
          <tr><td /><td><b>TO OBLIGATE:</b><br /><br />Travel expenses incurred during official travel for the month of <b>{monthLabel(record.month)}</b> with supporting documents hereto attached in the amount of ...<br /><br />Charged to: <b>{chargedToForUnit(profile.unit)}</b></td><td /><td /><td>{formatTevAmount(totals.grandTotal)}</td></tr>
        </tbody></table>
      </div>
      <div className="mytev-ors-total-row"><table className="mytev-ors-total"><colgroup><col /><col /><col /><col /><col /></colgroup><tbody><tr><td colSpan={4}><strong>Total</strong></td><td><strong>{formatTevAmount(totals.grandTotal)}</strong></td></tr></tbody></table></div>
      <div className="mytev-ors-certifications">
        <div className="mytev-ors-certified"><b>A</b><p><strong>Certified:</strong> Charges to appropriation/allotment are necessary, lawful and under my direct supervision; and supporting documents valid, proper and legal.</p><div className="mytev-ors-signature"><span><b>Signature</b><em>:</em><i /></span><span><b>Printed Name</b><em>:</em><strong>{signatory.name.toLocaleUpperCase("en-PH")}</strong></span><span><b>Position</b><em>:</em><i>{signatory.position === "Chief" ? <em>Chief</em> : signatory.position}, {tevDivisionLabel(record.divisionName)}</i></span><span><b>Date</b><em>:</em><i /></span></div></div>
        <div className="mytev-ors-certified"><b>B</b><p><strong>Certified:</strong> Allotment available and obligated for the purpose/adjustment necessary as indicated above.</p><div className="mytev-ors-signature"><span><b>Signature</b><em>:</em><i /></span><span><b>Printed Name</b><em>:</em><strong>{tevOrsBudgetSignatory.name.toLocaleUpperCase("en-PH")}</strong></span><span><b>Position</b><em>:</em><i><em>{budgetTitle}</em>, {budgetSection}</i></span><span><b>Date</b><em>:</em><i /></span></div></div>
      </div>
      <div className="mytev-ors-status">
        <table className="mytev-ors-status-header"><colgroup><col /><col /><col /><col /><col /><col /><col /><col /></colgroup><thead>
          <tr className="mytev-ors-status-title"><th>C</th><th colSpan={7}>STATUS OF OBLIGATION</th></tr>
          <tr className="mytev-ors-status-groups"><th className="mytev-ors-status-date-spacer" /><th colSpan={2}>Reference</th><th colSpan={5}>Amount</th></tr>
          <tr><th className="mytev-ors-status-date" rowSpan={3}>Date</th><th rowSpan={3}>Particulars</th><th className="mytev-ors-reference-number" rowSpan={3}>ORS/JEV/Check/ADA/TRA No.</th><th rowSpan={2}>Obligation</th><th rowSpan={2}>Payable</th><th className="mytev-ors-payment-heading" rowSpan={2}>Payment</th><th colSpan={2}>Balance</th></tr>
          <tr><th className="mytev-ors-balance-heading mytev-ors-balance-not-yet">Not Yet Due</th><th className="mytev-ors-balance-heading">Due and Demandable</th></tr>
          <tr><th>(a)</th><th>(b)</th><th>(c)</th><th>(a-b)</th><th>(b-c)</th></tr>
        </thead></table>
        <table className="mytev-ors-status-blank" aria-hidden="true"><colgroup><col /><col /><col /><col /><col /><col /><col /><col /></colgroup><tbody><tr>{Array.from({ length: 8 }, (_, cellIndex) => <td key={`ors-status-${cellIndex}`} />)}</tr></tbody></table>
      </div>
    </div>
  </article></div>;
}

function MyTevDisbursementPage({ record, rates }: { record: MyTevRecord; rates: TevRegionRate[] }) {
  const profile = record.profile;
  const signatory = divisionSignatory(record.divisionName);
  const totals = totalsForRecord(record.itineraries, rates);
  const monthAndYear = monthLabel(record.month);
  const [approvingPosition, ...approvingOfficeParts] = tevDvApprovingSignatory.position.split(", ");
  const approvingOffice = approvingOfficeParts.join(", ");
  return <div className="mytev-paper-frame"><article className="mytev-paper mytev-dv-paper">
    <div className="mytev-dv-document">
      <div className="mytev-dv-top"><div className="mytev-dv-letterhead"><MyTevLetterhead /><h1>DISBURSEMENT VOUCHER</h1></div><div className="mytev-dv-number-fields"><span className="mytev-dv-appendix">Appendix 32</span><div className="mytev-dv-fund-cluster"><b>Fund Cluster :</b><span>{tevFundCluster}</span></div><div className="mytev-dv-number-field"><b>Date :</b><i /></div><div className="mytev-dv-number-field"><b>DV No. :</b><i /></div></div></div>
      <div className="mytev-dv-payment-mode"><strong>Mode of Payment</strong>{["MDS Check", "Commercial Check", "ADA", "Others (Please specify)"].map((mode) => <span key={mode}><i />{mode}</span>)}</div>
      <div className="mytev-dv-payee">
        <div className="mytev-dv-payee-main"><b>Payee</b><span className="mytev-dv-payee-name" style={fitTextStyle(profile.name, 45, "--mytev-font-12", 1.1)}>{profile.name}</span><div className="mytev-dv-payee-field"><b>TIN/Employee No.:</b><span style={fitTextStyle(profile.taxIdentificationNo, 20, "--mytev-font-12", 1.1)}>{profile.taxIdentificationNo}</span></div><div className="mytev-dv-payee-field"><b>ORS/BURS No.:</b><span /></div></div>
        <div className="mytev-dv-address-row"><b>Address</b><span className="mytev-dv-address" style={fitTextStyle(profile.address, 90, "--mytev-font-12", 1.1)}>{profile.address}</span></div>
      </div>
      <table className="mytev-dv-particulars"><thead><tr><th>Particulars</th><th>Responsibility Center</th><th>MFO/PAP</th><th>Amount</th></tr></thead><tbody><tr><td><b>FOR PAYMENT:</b><br /><br />For reimbursement of travel expenses incurred during official travels for the <strong>{monthAndYear}</strong> with supporting documents hereto attached in the amount of ...</td><td /><td /><td>{formatTevAmount(totals.grandTotal)}</td></tr></tbody><tfoot><tr className="mytev-dv-total"><th colSpan={3}>Amount Due</th><th>{formatTevAmount(totals.grandTotal)}</th></tr></tfoot></table>
      <div className="mytev-dv-certified">
        <div className="mytev-dv-certified-heading"><b>A.</b><strong>Certified: Expenses/Cash Advance necessary, lawful and incurred under my direct supervision.</strong></div>
        <div className="mytev-dv-certified-signatory"><strong>{signatory.name}</strong><span><i>{signatory.position}</i>, {tevDivisionLabel(record.divisionName)}</span></div>
      </div>
      <div className="mytev-dv-accounting">
        <div className="mytev-dv-accounting-heading"><b>B.</b><strong>Accounting Entry:</strong></div>
        <table><thead><tr><th>Account Title</th><th>UACS Code</th><th>Debit</th><th>Credit</th></tr></thead><tbody><tr><td /><td /><td /><td /></tr></tbody></table>
      </div>
      <div className="mytev-dv-approval">
        <section>
          <div className="mytev-dv-approval-heading"><b>C.</b><strong>Certified:</strong></div>
          <div className="mytev-dv-approval-main mytev-dv-approval-main-left"><span><i /><span>Cash available</span></span><span><i /><span>Subject to Authority to Debit Account (when applicable)</span></span><span><i /><span>Supporting documents complete and amount claimed<br />proper</span></span></div>
          <div className="mytev-dv-signatory-table">
            <div className="mytev-dv-signatory-row"><b>Signature</b><span /></div>
            <div className="mytev-dv-signatory-row"><b>Printed<br />Name</b><strong>{tevDvAccountingSignatory.name.toLocaleUpperCase("en-PH")}</strong></div>
            <div className="mytev-dv-signatory-row mytev-dv-position-row"><b>Position</b><div><span>{tevDvAccountingSignatory.position}</span><span><i>{tevDvAccountingSignatory.designation}</i></span></div></div>
            <div className="mytev-dv-signatory-row"><b>Date</b><span /></div>
          </div>
        </section>
        <section>
          <div className="mytev-dv-approval-heading"><b>D.</b><strong>Approved for Payment</strong></div>
          <div className="mytev-dv-approval-main mytev-dv-approval-main-right"><div /><div /><div className="mytev-dv-approval-amount"><span>(₱ ____________________)</span></div><strong>(Amount in words and in figure)</strong></div>
          <div className="mytev-dv-signatory-table">
            <div className="mytev-dv-signatory-row"><b>Signature</b><span /></div>
            <div className="mytev-dv-signatory-row"><b>Printed<br />Name</b><strong>{tevDvApprovingSignatory.name.toLocaleUpperCase("en-PH")}</strong></div>
            <div className="mytev-dv-signatory-row mytev-dv-position-row"><b>Position</b><div><span><i>{approvingPosition},</i> {approvingOffice}</span><span><i>{tevDvApprovingSignatory.designation}</i></span></div></div>
            <div className="mytev-dv-signatory-row"><b>Date</b><span /></div>
          </div>
        </section>
      </div>
      <div className="mytev-dv-receipt">
        <div className="mytev-dv-receipt-main">
          <div className="mytev-dv-receipt-heading"><b>E.</b><strong>Receipt of Payment</strong></div>
          <div className="mytev-dv-receipt-row"><b>Check/<br />ADA No. :</b><span /><b>Date :</b><strong>Bank Name &amp; Account Number:</strong></div>
          <div className="mytev-dv-receipt-row"><b>Signature :</b><span /><b>Date :</b><strong>Printed Name:</strong></div>
          <div className="mytev-dv-receipt-other"><strong>Official Receipt No. &amp; Date/Other Documents:</strong></div>
        </div>
        <div className="mytev-dv-receipt-jev"><strong>JEV No.</strong><strong>Date</strong></div>
      </div>
    </div>
  </article></div>;
}

function MyTevCenrrPage({ record, page, pageNumber, pageCount, grandTotal }: { record: MyTevRecord; page: DocumentRowPage<ReturnType<typeof cenrrRows>[number]>; pageNumber: number; pageCount: number; grandTotal: number }) {
  const profile = record.profile;
  const signatory = divisionSignatory(record.divisionName);
  const rows = pageRowsWithFillers(page, maxCenrrRows, 123, 4.2);
  const pageRows = rows.map(({ row }) => row);
  const pageTotal = page.rows.reduce((sum, row) => sum + row.amount, 0);
  const isFinalPage = pageNumber === pageCount;
  return <div className="mytev-paper-frame"><article className="mytev-paper mytev-cenrr-paper">
    <div className="mytev-cenrr-document">
      <MyTevLetterhead />
      <div className="mytev-cenrr-heading">
        <h1>CERTIFICATION OF EXPENSES NOT REQUIRING RECEIPTS{pageCount > 1 ? " (CONTINUED)" : ""}</h1>
        <p className="mytev-cenrr-legal">Pursuant to COA Circular No. <u>2017-001</u> dated <u>June 19, 2017</u></p>
      </div>
      <div className="mytev-cenrr-fields">
        <div><b>Name of Employee:</b><span style={fitTextStyle(profile.name, 48)}>{profile.name}</span><b>Employee No.:</b><span style={fitTextStyle(profile.taxIdentificationNo, 22)}>{profile.taxIdentificationNo}</span></div>
        <div><b>Office:</b><span style={fitTextStyle(tevOrsOffice, 60)}>{tevOrsOffice}</span></div>
        <div><b>Division:</b><span style={fitTextStyle(tevDivisionLabel(record.divisionName), 55)}>{tevDivisionLabel(record.divisionName)}</span></div>
      </div>
      <div className="mytev-cenrr-divider" />
      <table className="mytev-cenrr-table"><thead><tr><th>DATE</th><th>PARTICULARS</th><th>MEANS OF<br />TRANSPORTATION</th><th>AMOUNT</th></tr></thead><tbody>
        {rows.map(({ row, height }, index) => {
          const previousRow = rows[index - 1]?.row;
          const hasDate = Boolean(row && (row.dateFrom || row.dateTo));
          const sameDateAsPrevious = Boolean(hasDate && previousRow && (previousRow.dateFrom || previousRow.dateTo) && row?.dateFrom === previousRow.dateFrom && row?.dateTo === previousRow.dateTo);
          return <tr key={`cenrr-line-${pageNumber}-${index}`} style={{ height: `${height}mm` }}>{!sameDateAsPrevious && <td rowSpan={hasDate ? cenrrDateRowSpan(pageRows, index) : 1}>{row && hasDate ? formatTevDateRange(row.dateFrom, row.dateTo) : ""}</td>}<td>{row?.visitedPlaces}</td><td className="mytev-cenrr-means">{row?.meansOfTransportation}</td><td>{row ? formatTevAmount(row.amount) : ""}</td></tr>;
        })}
      </tbody><tfoot><tr className="mytev-cenrr-total"><th colSpan={3}>{pageCount === 1 ? "Total" : isFinalPage ? "Grand Total" : `Page ${pageNumber} Subtotal — Continued`}</th><th>{formatTevAmount(isFinalPage ? grandTotal : pageTotal)}</th></tr></tfoot></table>
      <p className="mytev-cenrr-purpose"><b>Purpose:</b> <i>Please see attached Travel Orders.</i></p>
      <p className="mytev-cenrr-declaration">I hereby certify that the above expenses are incurred as they are necessary for the above cited purpose, that above goods and services were acquired from parties not issuing receipts. And that I am fully aware that willful falsification of statements is punishable by law.</p>
      <table className="mytev-cenrr-signatures"><colgroup><col /><col /><col /></colgroup><tbody>
        <tr><td /><th>Certified Correct:</th><th>Noted:</th></tr>
        <tr><th scope="row">Signature</th><td /><td /></tr>
        <tr><th scope="row">Printed Name</th><td><strong style={fitTextStyle(profile.name, 42)}>{profile.name.toLocaleUpperCase("en-PH")}</strong></td><td><strong style={fitTextStyle(signatory.name, 42)}>{signatory.name.toLocaleUpperCase("en-PH")}</strong></td></tr>
        <tr><td /><td>Employee</td><td>Immediate Supervisor</td></tr>
        <tr><td /><td className="mytev-cenrr-signature-date mytev-cenrr-signature-date-left"><div><b>Date</b><span /></div></td><td className="mytev-cenrr-signature-date mytev-cenrr-signature-date-right"><div><b>Date</b><span /></div></td></tr>
        <tr><td /><td /><td /></tr>
      </tbody></table>
    </div>
  </article></div>;
}

function MyTevCtcPage({ record }: { record: MyTevRecord }) {
  const profile = record.profile;
  const signatory = divisionSignatory(record.divisionName);
  const references = formatTevTravelReferences(record.travelReferences);
  const certification = record.certificationOfTravel ?? defaultTevCertificationOfTravel();
  const hasExplanation = Boolean((certification.cutShort || certification.extended || certification.otherDeviation) && certification.otherExplanation.trim());
  const denseContent = references.length > 120 || record.evidenceOfTravel.length > 140 || certification.otherExplanation.length > 150;
  return <div className="mytev-paper-frame"><article className="mytev-paper mytev-ctc-paper">
    <div className={`mytev-ctc-document${denseContent ? " mytev-ctc-document-dense" : ""}${hasExplanation ? " mytev-ctc-document-has-approval" : ""}`}>
      <MyTevLetterhead appendix="Appendix 47" />
      <h1>CERTIFICATION OF TRAVEL COMPLETED</h1>
      <div className="mytev-ctc-entity"><b>Entity Name:</b><span>{tevEntityName}</span><b>Fund Cluster:</b><span>{tevFundCluster}</span></div>
      <div className="mytev-ctc-station"><div><b style={fitTextStyle(tevCtcDirector, 48)}>{tevCtcDirector.toLocaleUpperCase("en-PH")}</b><em>Director-In-Charge</em></div><div><b style={{ ...fitTextStyle(tevCtcDirectorOffice, 32), whiteSpace: "nowrap", overflowWrap: "normal" }}>{tevCtcDirectorOffice.toLocaleUpperCase("en-PH")}</b><span>Station</span></div></div>
      <p className="mytev-ctc-statement" style={fitTextStyle(references, 220)}><b>I HEREBY CERTIFY THAT</b> I have completed the travel as authorized in Travel Order/Itinerary of Travel Nos. <strong>{references}</strong>, under the conditions indicated below:</p>
      <div className="mytev-ctc-conditions">
        <p><i className={certification.strictlyInAccordance ? "is-checked" : undefined} /><span>Strictly in accordance with the approved itinerary.</span></p>
        <p className="mytev-ctc-cut-short"><i className={certification.cutShort ? "is-checked" : undefined} /><span>Cut short as explained below. Amount: ₱ <span className="mytev-ctc-inline-value mytev-ctc-inline-amount">{certification.cutShort && certification.cutShortAmount ? certification.cutShortAmount : " "}</span> · OR No.: <span className="mytev-ctc-inline-value mytev-ctc-inline-or">{certification.cutShort && certification.cutShortOrNo ? certification.cutShortOrNo : " "}</span> · Date: <span className="mytev-ctc-inline-value mytev-ctc-inline-date">{certification.cutShort && certification.cutShortDate ? formatTevDate(certification.cutShortDate) : " "}</span></span></p>
        <p><i className={certification.extended ? "is-checked" : undefined} /><span>Extended as explained below, additional itinerary was submitted.</span></p>
        <p><i className={certification.otherDeviation ? "is-checked" : undefined} /><span>Other deviation as explained below.</span></p>
      </div>
      <div className="mytev-ctc-explanation"><b>Explanation or Justification:</b><span className={hasExplanation ? "has-value" : undefined}>{certification.cutShort || certification.extended || certification.otherDeviation ? certification.otherExplanation : ""}</span>{!hasExplanation && <span />}</div>
      <div className="mytev-ctc-evidence"><b>Evidence of Travel:</b><span style={fitTextStyle(record.evidenceOfTravel, 150)}>{record.evidenceOfTravel}</span></div>
      <p className="mytev-ctc-submitted">Respectfully submitted:</p>
      <div className="mytev-ctc-employee"><strong style={fitTextStyle(profile.name, 36)}>{profile.name.toLocaleUpperCase("en-PH")}</strong><span>Name of Employee</span></div>
      <p className="mytev-ctc-knowledge">On evidence and information of which I have the knowledge, the travel was actually undertaken.</p>
      <p className="mytev-ctc-noted">Noted:</p>
      <div className="mytev-ctc-signatory"><strong style={fitTextStyle(signatory.name, 36)}>{signatory.name.toLocaleUpperCase("en-PH")}</strong><span><em>{signatory.position}</em>, {tevDivisionLabel(record.divisionName)}</span></div>
      {hasExplanation && <>
        <div className="mytev-ctc-approval-spacer-row" aria-hidden="true" />
        <p className="mytev-ctc-approved">Approved:</p>
        <div className="mytev-ctc-approval-spacer-row" aria-hidden="true" />
        <div className="mytev-ctc-signatory mytev-ctc-approving-signatory"><strong>ENGR. RICARDO M. OÑATE JR.</strong><span><em>Regional Executive Director</em></span></div>
      </>}
    </div>
  </article></div>;
}

export default function MyTevDocuments({ record, rates, order = "preview" }: { record: MyTevRecord; rates: TevRegionRate[]; order?: "preview" | "print" }) {
  const itineraryPages = record.itineraries.flatMap((itinerary) => {
    const pages = paginateRows(itinerary.rows, maxItineraryRows, 134, 7, itineraryRowHeight);
    return pages.map((page, index) => ({ itinerary, page, pageNumber: index + 1 }));
  }).map((entry, index) => ({ ...entry, documentPageNumber: index + 1 }));
  const itineraryTotals = totalsForRecord(record.itineraries, rates);
  const cenrrList = cenrrRows(record.itineraries);
  const cenrrPages = paginateRows(cenrrList, maxCenrrRows, 123, 4.2, cenrrRowHeight);
  const cenrrGrandTotal = cenrrList.reduce((sum, row) => sum + row.amount, 0);
  const itineraryDocuments = itineraryPages.map(({ itinerary, page, pageNumber, documentPageNumber }, index) => <MyTevItineraryPage key={`${itinerary.id}-${pageNumber - 1}`} record={record} itinerary={itinerary} page={page} pageNumber={pageNumber} documentPageNumber={documentPageNumber} isLastDocumentPage={index === itineraryPages.length - 1} recordTotals={itineraryTotals} rates={rates} />);
  const orsDocument = <MyTevOrsPage record={record} rates={rates} />;
  const disbursementDocument = <MyTevDisbursementPage record={record} rates={rates} />;
  const cenrrDocuments = cenrrPages.map((page, index) => <MyTevCenrrPage key={`cenrr-${index}`} record={record} page={page} pageNumber={index + 1} pageCount={cenrrPages.length} grandTotal={cenrrGrandTotal} />);
  const ctcDocument = <MyTevCtcPage record={record} />;
  return <div className="mytev-preview-pages">
    {order === "print" ? <>{disbursementDocument}{orsDocument}{itineraryDocuments}{cenrrDocuments}{ctcDocument}</> : <>{itineraryDocuments}{orsDocument}{disbursementDocument}{cenrrDocuments}{ctcDocument}</>}
  </div>;
}
