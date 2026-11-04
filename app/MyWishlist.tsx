"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { doc, onSnapshot } from "firebase/firestore";
import type { AccountRole } from "@/lib/user-roles";
import { db, functions } from "@/lib/firebase";
import "./my-wishlist.css";

type WishlistItem = {
  desiredGift: string;
  description: string;
  amount?: string;
  link?: string;
};

type RevealedWishlist = {
  nickname: string;
  wishlist: WishlistItem[];
  cycleId: string;
};

type WishlistState = {
  nickname: string;
  wishlist: WishlistItem[];
  participantCount: number;
  completedCount: number;
  ready: boolean;
  drawActive: boolean;
  isParticipant: boolean;
  revealed: RevealedWishlist | null;
};

type WishlistStatus = {
  participantCount: number;
  completedCount: number;
  ready: boolean;
  drawActive: boolean;
  revealedCount: number;
  remainingCount: number;
};

const emptyWishlist: WishlistItem[] = [];

async function callGetWishlistState() {
  if (!functions) throw new Error("Wishlist storage is unavailable.");
  const callable = httpsCallable<void, WishlistState>(functions, "getMyWishlistState");
  return (await callable()).data;
}

export function canAccessMyWishlist(role: AccountRole, office: string, division: string, unit: string, designation: string) {
  return (role === "regular"
      && office === "Division"
      && division === "Field Operations Division"
      && ["AGRISTAT", "AMIA", "DRRM"].includes(unit))
    || (role === "admin"
      && office === "Division"
      && division === "Field Operations Division"
      && unit === "Field Operations Division"
      && designation === "AGRISTAT/DRRM/AMIA Project Leader");
}

export function MyWishlist({ user, role, office, division, unit, designation }: {
  user: User;
  role: AccountRole;
  office: string;
  division: string;
  unit: string;
  designation: string;
}) {
  const [state, setState] = useState<WishlistState | null>(null);
  const [status, setStatus] = useState<WishlistStatus | null>(null);
  const [nickname, setNickname] = useState("");
  const [wishlist, setWishlist] = useState<WishlistItem[]>(emptyWishlist);
  const [desiredGift, setDesiredGift] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [link, setLink] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const refreshState = useCallback(async () => {
    const currentState = await callGetWishlistState();
    setState(currentState);
    setNickname(currentState.nickname ?? "");
    setWishlist(currentState.wishlist ?? emptyWishlist);
    return currentState;
  }, []);

  useEffect(() => {
    let active = true;
    void callGetWishlistState().then((currentState) => {
      if (!active) return;
      setState(currentState);
      setNickname(currentState.nickname ?? "");
      setWishlist(currentState.wishlist ?? emptyWishlist);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "Could not load your wishlist.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    if (!db) return () => { active = false; };
    const stopStatus = onSnapshot(doc(db, "myWishlistStatus", "current"), (snapshot) => {
      if (active && snapshot.exists()) setStatus(snapshot.data() as WishlistStatus);
    }, (cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "Could not load the Elfster status.");
    });
    return () => { active = false; stopStatus(); };
  }, []);

  async function saveNickname(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanNickname = nickname.trim();
    if (!cleanNickname) {
      setError("Add your nickname before entering a wishlist.");
      return;
    }
    if (!functions) {
      setError("Wishlist storage is unavailable.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const save = httpsCallable<{ nickname: string }, { saved: boolean }>(functions, "saveMyWishlist");
      await save({ nickname: cleanNickname });
      await refreshState();
      setMessage("Nickname saved. You can now add one or more wishlist items.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save your nickname.");
    } finally {
      setBusy(false);
    }
  }

  function addWishlistItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanGift = desiredGift.trim();
    const cleanDescription = description.trim();
    if (!cleanGift || !cleanDescription) {
      setError("Enter both a Desired Gift and its Description.");
      return;
    }
    if (wishlist.length >= 20) {
      setError("You can add up to 20 wishlist items.");
      return;
    }
    setError("");
    setMessage("");
    setWishlist((current) => [...current, { desiredGift: cleanGift, description: cleanDescription, amount: amount.trim(), link: link.trim() }]);
    setDesiredGift("");
    setDescription("");
    setAmount("");
    setLink("");
  }

  async function saveWishlist() {
    if (!functions) {
      setError("Wishlist storage is unavailable.");
      return;
    }
    if (!nickname.trim()) {
      setError("Save your nickname before saving a wishlist.");
      return;
    }
    if (wishlist.length === 0) {
      setError("Add at least one wishlist item before saving.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const save = httpsCallable<{ nickname: string; wishlist: WishlistItem[] }, { saved: boolean }>(functions, "saveMyWishlist");
      await save({ nickname: nickname.trim(), wishlist });
      await refreshState();
      setMessage("Your wishlist is saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save your wishlist.");
    } finally {
      setBusy(false);
    }
  }

  async function revealElfster() {
    if (!functions) {
      setError("Wishlist storage is unavailable.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const reveal = httpsCallable<void, RevealedWishlist & { alreadyRevealed: boolean }>(functions, "revealElfster");
      const result = await reveal();
      const revealed = { nickname: result.data.nickname, wishlist: result.data.wishlist, cycleId: result.data.cycleId };
      setState((current) => current ? { ...current, revealed, drawActive: true } : current);
      await refreshState();
      setMessage(result.data.alreadyRevealed ? "Your Elfster reveal is ready." : "Your Elfster reveal is ready. This nickname has been removed from the available draw.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reveal your Elfster match.");
    } finally {
      setBusy(false);
    }
  }

  const participantCount = status?.drawActive ? status.participantCount : status?.participantCount ?? state?.participantCount ?? 0;
  const completedCount = status?.drawActive ? status.completedCount : status?.completedCount ?? state?.completedCount ?? 0;
  const drawActive = status?.drawActive ?? state?.drawActive ?? false;
  const ready = status?.ready ?? state?.ready ?? false;
  const availableNicknameCount = drawActive
    ? (status?.drawActive ? status.remainingCount ?? 0 : 0)
    : completedCount;
  const isEligible = canAccessMyWishlist(role, office, division, unit, designation);

  if (!isEligible) return null;

  return <section className="my-wishlist-page" aria-labelledby="my-wishlist-title">
    <header className="my-wishlist-heading">
      <p className="eyebrow">Field Operations Division</p>
      <h2 id="my-wishlist-title">myWishlist</h2>
      <p className="muted">Add your nickname first, then save one or more gift ideas for your Elfster match.</p>
    </header>

    {error && <p className="my-wishlist-message is-error" role="alert">{error}</p>}
    {message && <p className="my-wishlist-message is-success" role="status">{message}</p>}

    {loading ? <p className="muted">Loading myWishlist...</p> : <>
      <section className="my-wishlist-progress" aria-live="polite">
        <div><strong>{completedCount} of {participantCount}</strong><span>specified users have saved a wishlist</span></div>
        <p>{drawActive
          ? "The Elfster draw is active. Wishlists are locked while matches are revealed."
          : participantCount < 2
            ? "At least two eligible users are needed before Reveal Elfster can open."
            : ready
              ? "At least two specified users have entered a wishlist. Reveal Elfster is ready."
              : "Reveal Elfster opens after at least two specified users have entered a wishlist."}</p>
      </section>

      {state?.isParticipant === false && <p className="my-wishlist-message is-error" role="status">A draw is already active, and your account was not part of the participants who entered before it began.</p>}

      {!drawActive && <>
        <section className="my-wishlist-card">
          <h3>Your nickname</h3>
          <p className="muted">Choose a unique nickname that will appear in the draw.</p>
          <form className="my-wishlist-form my-wishlist-nickname-form" onSubmit={(event) => void saveNickname(event)}>
            <label>Nickname<input autoComplete="off" maxLength={40} value={nickname} onChange={(event) => setNickname(event.target.value)} required disabled={busy} placeholder="Enter your nickname" /></label>
            <button type="submit" disabled={busy || !nickname.trim()}>{busy ? "Saving..." : "Save Nickname"}</button>
          </form>
        </section>

        {state?.nickname && <section className="my-wishlist-card">
          <h3>Your wishlist</h3>
          <p className="muted">Add at least one gift idea. Description is required; Amount and Link are optional.</p>
          <form className="my-wishlist-form my-wishlist-item-form" onSubmit={(event) => void addWishlistItem(event)}>
            <label>Desired Gift<input maxLength={160} value={desiredGift} onChange={(event) => setDesiredGift(event.target.value)} required disabled={busy} placeholder="What would you like?" /></label>
            <label className="my-wishlist-description-field">Description<textarea maxLength={1000} value={description} onChange={(event) => setDescription(event.target.value)} required disabled={busy} placeholder="Add details to help your match choose" rows={3} /></label>
            <label>Amount <span>(optional)</span><input maxLength={80} value={amount} onChange={(event) => setAmount(event.target.value)} disabled={busy} placeholder="e.g. ₱500" /></label>
            <label>Link <span>(optional)</span><input type="url" maxLength={2048} value={link} onChange={(event) => setLink(event.target.value)} disabled={busy} placeholder="https://..." /></label>
            <button type="submit" disabled={busy || wishlist.length >= 20}>Add to Wishlist</button>
          </form>

          {wishlist.length > 0 && <div className="my-wishlist-items">
            <h4>{wishlist.length} {wishlist.length === 1 ? "gift idea" : "gift ideas"}</h4>
            <div className="my-wishlist-table-wrap" role="region" aria-label="Wishlist items" tabIndex={0}>
              <table className="my-wishlist-table">
                <thead><tr>
                  <th scope="col">Desired Gift</th>
                  <th scope="col">Description</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Link</th>
                  <th scope="col">Remove</th>
                </tr></thead>
                <tbody>{wishlist.map((item, index) => <tr key={`${item.desiredGift}-${index}`}>
                  <td>{item.desiredGift}</td>
                  <td className="my-wishlist-table-description">{item.description}</td>
                  <td>{item.amount || "-"}</td>
                  <td>{item.link ? <a className="my-wishlist-item-link" href={item.link} target="_blank" rel="noopener noreferrer">Open gift link</a> : "-"}</td>
                  <td><button type="button" className="my-wishlist-remove" aria-label={`Remove ${item.desiredGift}`} disabled={busy} onClick={() => setWishlist((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove</button></td>
                </tr>)}</tbody>
              </table>
            </div>
            <button type="button" className="my-wishlist-save-list" disabled={busy} onClick={() => void saveWishlist()}>{busy ? "Saving..." : "Save Wishlist"}</button>
          </div>}
        </section>}
      </>}

      {state?.revealed ? <section className="my-wishlist-reveal" aria-live="polite">
        <p className="eyebrow">Your Elfster match</p>
        <h3>{state.revealed.nickname}</h3>
        <p className="muted">This nickname has been removed from the available draw. Here is the saved wishlist:</p>
        <div className="my-wishlist-table-wrap my-wishlist-revealed-items" role="region" aria-label={`${state.revealed.nickname}'s wishlist`} tabIndex={0}>
          <table className="my-wishlist-table my-wishlist-revealed-table">
            <thead><tr>
              <th scope="col">Desired Gift</th>
              <th scope="col">Description</th>
              <th scope="col">Amount</th>
              <th scope="col">Link</th>
            </tr></thead>
            <tbody>{state.revealed.wishlist.map((item, index) => <tr key={`${item.desiredGift}-${index}`}>
              <td>{item.desiredGift}</td>
              <td className="my-wishlist-table-description">{item.description}</td>
              <td>{item.amount || "-"}</td>
              <td>{item.link ? <a className="my-wishlist-item-link" href={item.link} target="_blank" rel="noopener noreferrer">Open gift link</a> : "-"}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </section> : <section className="my-wishlist-reveal-action">
        <div><h3>Reveal Elfster</h3><p className="muted">Once you reveal your Elfster match, you cannot change it. For the best experience, wait until at least 15 users have saved their wishlists before revealing.</p></div>
        <button type="button" onClick={() => void revealElfster()} disabled={busy || !ready || availableNicknameCount <= 0 || !state?.isParticipant || !state?.nickname || state.wishlist.length === 0}>{busy ? "Revealing..." : "Reveal Elfster"}</button>
      </section>}
    </>}
  </section>;
}
