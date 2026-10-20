"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { User } from "firebase/auth";
import { arrayUnion, collection, deleteField, doc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc, updateDoc, where, writeBatch, type Timestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { accountDivisionOptions, accountOfficeOptions, accountProfileSelection, divisionsForOffice, executiveOfficeDivisionOptions, unitsForOfficeDivision } from "@/lib/account-profile";
import { isSuperadminRole, normalizeAccountRole, type AccountRole } from "@/lib/user-roles";
import DeleteConfirmation from "./DeleteConfirmation";
import "./messenger.css";

type Person = { id: string; name: string; position: string; office: string; division: string; unit: string; photoURL: string };
type Chat = { id: string; members: string[]; pending?: boolean; lastText?: string; lastSenderId?: string; lastAt?: Timestamp | null; readAt?: Record<string, Timestamp | null>; clearedAt?: Record<string, Timestamp | null> };
type MessageKind = "text" | "sticker" | "gif";
type ReplyRef = { id: string; senderId: string; kind: MessageKind; text: string };
type Message = { id: string; senderId: string; kind: MessageKind; text: string; deleted?: boolean; reactions?: Record<string, string>; replyTo?: ReplyRef; createdAt?: Timestamp | null };
type Picker = "emoji" | "sticker" | "gif" | null;
type GifResult = { id: string; url: string };

const allDivisionsFilter = "All";
const allUnitsFilter = "All";
const profileSelectionFromProps = (office?: string | null, division?: string | null, unit?: string | null, assignment?: string | null) =>
  division !== undefined || unit !== undefined
    ? accountProfileSelection({ office: office ?? "", division: division ?? "", unit: unit ?? "", profileFieldsVersion: 4 })
    : accountProfileSelection({ office: office ?? "", assignment: assignment ?? "", profileFieldsVersion: 3 });
const profileDivisionFilterValue = (office?: string | null, division?: string | null, unit?: string | null, assignment?: string | null) => profileSelectionFromProps(office, division, unit, assignment).division || allDivisionsFilter;
const profileUnitFilterValue = (office?: string | null, division?: string | null, unit?: string | null, assignment?: string | null) => profileSelectionFromProps(office, division, unit, assignment).unit || allUnitsFilter;
const allOfficeDivisions = [...accountDivisionOptions, ...executiveOfficeDivisionOptions];
const allOfficeUnits = [...new Set(accountOfficeOptions.flatMap((office) => divisionsForOffice(office).flatMap((division) => unitsForOfficeDivision(office, division))))];
const emojis = ["😀", "😁", "😂", "🤣", "😊", "😍", "😘", "😎", "🤔", "😅", "😢", "😭", "😡", "🥳", "😴", "🙄", "👍", "👎", "👏", "🙏", "💪", "🤝", "👌", "✌️", "❤️", "💔", "🔥", "✨", "🎉", "✅", "❌", "⭐"];
const stickers = ["👍", "❤️", "😂", "🎉", "🙏", "😍", "🔥", "👏", "😢", "😎", "🥳", "💯", "🤝", "🙌", "😴", "🤔"];
const MAX_TEXT = 2000;
const reactionOptions = [
  { key: "laughing", emoji: "😂", label: "Laughing" },
  { key: "heart", emoji: "❤️", label: "Love" },
  { key: "like", emoji: "👍", label: "Like" },
  { key: "wow", emoji: "😮", label: "Wow" },
  { key: "sad", emoji: "😢", label: "Sad" },
  { key: "angry", emoji: "😡", label: "Angry" },
];
const giphyKey = process.env.NEXT_PUBLIC_GIPHY_API_KEY;

const chatIdFor = (first: string, second: string) => [first, second].sort().join("_");
const millis = (value?: Timestamp | null) => value?.toMillis?.() ?? 0;
const isUnread = (chat: Chat, userId: string) => Boolean(chat.lastSenderId && chat.lastSenderId !== userId && millis(chat.lastAt) > millis(chat.readAt?.[userId]));
const unitLabel = (division: string, unit: string) => unit && unit !== division ? `${division} · ${unit}` : division || unit;
const isHttpsUrl = (value: string) => { try { return new URL(value).protocol === "https:" && value.length <= 500; } catch { return false; } };
const publicAsset = (path: string) => `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`;

function PersonAvatar({ person, className = "" }: { person: Person; className?: string }) {
  const fallback = publicAsset("/da-default-dp.png");
  const src = person.photoURL && isHttpsUrl(person.photoURL) ? person.photoURL : fallback;
  return <img className={`messenger-avatar ${className}`} src={src} alt="" aria-hidden="true" onError={(event) => { event.currentTarget.src = fallback; }} />;
}

type LinkPreviewData = { title?: string; description?: string; image?: string; publisher?: string };
const urlPattern = /https?:\/\/[^\s<>"']+/gi;
const previewCache = new Map<string, LinkPreviewData | null>();

// Trailing punctuation is usually part of the sentence, not the link.
const cleanUrl = (value: string) => value.replace(/[.,!?;:)\]]+$/, "");
const firstUrl = (text: string) => { const match = text.match(urlPattern); return match ? cleanUrl(match[0]) : null; };

function linkify(text: string) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(urlPattern)) {
    const url = cleanUrl(match[0]);
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    parts.push(<a key={index} className="messenger-link" href={url} target="_blank" rel="noopener noreferrer nofollow">{url}</a>);
    last = index + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function LinkPreview({ url }: { url: string }) {
  const [preview, setPreview] = useState<LinkPreviewData | null | undefined>(() => previewCache.get(url));
  useEffect(() => {
    if (previewCache.has(url)) { setPreview(previewCache.get(url)); return; }
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}`, { signal: controller.signal });
        const body = await response.json() as { status?: string; data?: { title?: string; description?: string; publisher?: string; image?: { url?: string } | null } };
        const data = body.status === "success" ? body.data : undefined;
        const result = data && (data.title || data.description) ? { title: data.title, description: data.description, publisher: data.publisher, image: data.image?.url } : null;
        previewCache.set(url, result);
        setPreview(result);
      } catch {
        if (!controller.signal.aborted) { previewCache.set(url, null); setPreview(null); }
      }
    })();
    return () => controller.abort();
  }, [url]);
  if (!preview) return null;
  const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } })();
  return <a className="messenger-link-card" href={url} target="_blank" rel="noopener noreferrer nofollow">
    {preview.image && isHttpsUrl(preview.image) && <img src={preview.image} alt="" referrerPolicy="no-referrer" loading="lazy" />}
    <span><small>{preview.publisher || host}</small><strong>{preview.title || host}</strong>{preview.description && <em>{preview.description}</em>}</span>
  </a>;
}

function useChats(userId: string, onIncomingMessage?: () => void) {
  const [chats, setChats] = useState<Chat[]>([]);
  const onIncomingMessageRef = useRef(onIncomingMessage);
  useEffect(() => { onIncomingMessageRef.current = onIncomingMessage; }, [onIncomingMessage]);
  useEffect(() => {
    if (!db) return;
    let hasInitialSnapshot = false;
    const lastActivityByChat = new Map<string, string>();
    return onSnapshot(query(collection(db, "chats"), where("members", "array-contains", userId)), { includeMetadataChanges: true }, (snapshot) => {
      if (hasInitialSnapshot) {
        snapshot.docChanges().forEach((change) => {
          const item = change.doc;
          const chat = { id: item.id, ...item.data(), pending: item.metadata.hasPendingWrites } as Chat;
          const activity = chat.lastAt ? `${chat.lastAt.seconds}:${chat.lastAt.nanoseconds}` : "";
          const previousActivity = lastActivityByChat.get(chat.id);
          const hasNewActivity = change.type === "added" || (previousActivity !== undefined && previousActivity !== activity);
          if (hasNewActivity && chat.lastSenderId && chat.lastSenderId !== userId && !chat.lastText?.startsWith("Reacted ")) {
            onIncomingMessageRef.current?.();
          }
          lastActivityByChat.set(chat.id, activity);
        });
      } else {
        snapshot.docs.forEach((item) => {
          const chat = item.data() as Chat;
          lastActivityByChat.set(item.id, chat.lastAt ? `${chat.lastAt.seconds}:${chat.lastAt.nanoseconds}` : "");
        });
        if (!snapshot.metadata.fromCache) hasInitialSnapshot = true;
      }
      setChats(snapshot.docs.map((item) => ({ id: item.id, ...item.data(), pending: item.metadata.hasPendingWrites } as Chat)));
    }, () => setChats([]));
  }, [userId]);
  return chats;
}

export function MessengerButton({ user, active, onClick }: { user: User; active: boolean; onClick: () => void }) {
  const messageToneRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const tone = new Audio(publicAsset("/message_tone.mp3"));
    tone.preload = "auto";
    messageToneRef.current = tone;
    return () => {
      tone.pause();
      messageToneRef.current = null;
    };
  }, []);
  const playMessageTone = useCallback(() => {
    const tone = messageToneRef.current;
    if (!tone) return;
    tone.currentTime = 0;
    void tone.play().catch(() => undefined);
  }, []);
  const chats = useChats(user.uid, playMessageTone);
  const [superadminIds, setSuperadminIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!db) return;
    return onSnapshot(collection(db, "users"), (snapshot) => {
      setSuperadminIds(new Set(snapshot.docs.filter((item) => isSuperadminRole(item.data().accountRole)).map((item) => item.id)));
    }, () => setSuperadminIds(null));
  }, []);
  const unread = superadminIds ? chats.filter((chat) => {
    const other = chat.members.find((id) => id !== user.uid);
    return Boolean(other && !superadminIds.has(other) && isUnread(chat, user.uid));
  }).length : 0;
  return <button type="button" className={`notification-button messenger-button${active ? " active" : ""}`} aria-label={`Messages${unread ? `, ${unread} unread` : ""}`} title="Messages" onClick={onClick}>
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.6-.8L3 21l1.9-5.1A8.4 8.4 0 0 1 3 11.5 8.5 8.5 0 0 1 12 3a8.5 8.5 0 0 1 9 8.5z" /></svg>
    {unread > 0 && <span className="notification-badge" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
  </button>;
}

export default function MessengerModule({ user, profileOffice, profileDivision, profileUnit, profileAssignment, accountRole }: { user: User; profileOffice?: string | null; profileDivision?: string | null; profileUnit?: string | null; profileAssignment?: string | null; accountRole?: AccountRole }) {
  const chats = useChats(user.uid);
  const normalizedRole = normalizeAccountRole(accountRole, user.email);
  const allScopesByDefault = normalizedRole === "admin" || normalizedRole === "superadmin" || profileOffice === "Office of the Regional Executive Director";
  const [people, setPeople] = useState<Person[]>([]);
  const [loadingPeople, setLoadingPeople] = useState(true);
  const [search, setSearch] = useState("");
  const [divisionFilter, setDivisionFilter] = useState(() => allScopesByDefault ? allDivisionsFilter : profileDivisionFilterValue(profileOffice, profileDivision, profileUnit, profileAssignment));
  const [unitFilter, setUnitFilter] = useState(() => allScopesByDefault ? allUnitsFilter : profileUnitFilterValue(profileOffice, profileDivision, profileUnit, profileAssignment));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [picker, setPicker] = useState<Picker>(null);
  const [gifQuery, setGifQuery] = useState("");
  const [gifResults, setGifResults] = useState<GifResult[]>([]);
  const [gifSearchStatus, setGifSearchStatus] = useState<"loading" | "results" | "empty" | "error" | "unavailable">("loading");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Message | null>(null);
  const [deleting, setDeleting] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDivisionFilter(allScopesByDefault ? allDivisionsFilter : profileDivisionFilterValue(profileOffice, profileDivision, profileUnit, profileAssignment));
    setUnitFilter(allScopesByDefault ? allUnitsFilter : profileUnitFilterValue(profileOffice, profileDivision, profileUnit, profileAssignment));
  }, [allScopesByDefault, profileOffice, profileDivision, profileUnit, profileAssignment]);

  useEffect(() => {
    try {
      for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
        const key = sessionStorage.key(index);
        if (key?.startsWith("chika-history-")) sessionStorage.removeItem(key);
      }
    } catch { /* Browser storage is optional. */ }
  }, []);

  useEffect(() => {
    if (!db) { setLoadingPeople(false); return; }
    return onSnapshot(collection(db, "users"), (snapshot) => {
      setPeople(snapshot.docs.filter((item) => item.id !== user.uid && !isSuperadminRole(item.data().accountRole)).map((item) => {
        const data = item.data();
        const profile = accountProfileSelection(data);
        return { id: item.id, name: typeof data.name === "string" ? data.name : "", position: typeof data.position === "string" ? data.position : "", office: profile.office, division: profile.division, unit: profile.unit || profile.assignment, photoURL: typeof data.photoURL === "string" ? data.photoURL : "" };
      }).filter((person) => person.name));
      setLoadingPeople(false);
    }, () => {
      setError("Could not load people. Refresh and try again.");
      setLoadingPeople(false);
    });
  }, [user.uid]);

  const chatByPerson = useMemo(() => {
    const map = new Map<string, Chat>();
    const knownPeople = new Set(people.map((person) => person.id));
    chats.forEach((chat) => { const other = chat.members.find((id) => id !== user.uid); if (other && knownPeople.has(other)) map.set(other, chat); });
    return map;
  }, [chats, people, user.uid]);

  // Deleting a chat only clears your own copy: anything at or before clearedAt is hidden from you.
  const lastVisibleAt = (chat?: Chat) => chat && millis(chat.lastAt) > millis(chat.clearedAt?.[user.uid]) ? millis(chat.lastAt) : 0;

  const visiblePeople = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return people
      .filter((person) => {
        const hasVisibleMessages = lastVisibleAt(chatByPerson.get(person.id)) > 0;
        const matchesFilters = (!term || person.name.toLocaleLowerCase().includes(term))
          && (divisionFilter === allDivisionsFilter || person.division === divisionFilter)
          && (unitFilter === allUnitsFilter || person.unit === unitFilter);
        return hasVisibleMessages || matchesFilters;
      })
      .sort((left, right) => lastVisibleAt(chatByPerson.get(right.id)) - lastVisibleAt(chatByPerson.get(left.id)) || left.name.localeCompare(right.name, "en", { sensitivity: "base" }));
  }, [people, search, divisionFilter, unitFilter, chatByPerson]);

  const divisionOptions = allOfficeDivisions;
  const unitOptions = divisionFilter === allDivisionsFilter
    ? allOfficeUnits
    : [...new Set(accountOfficeOptions.flatMap((office) => unitsForOfficeDivision(office, divisionFilter)))];

  const selected = people.find((person) => person.id === selectedId) ?? null;
  const selectedChat = selected ? chatByPerson.get(selected.id) ?? null : null;
  // Listening before the server has the chat document is denied by the rules, so wait for the write to land.
  const selectedChatId = selectedChat && !selectedChat.pending ? selectedChat.id : null;

  useEffect(() => {
    if (!loadingPeople && selectedId && !selected) {
      setSelectedId(null);
      setReplyTo(null);
      setDraft("");
      setPicker(null);
    }
  }, [loadingPeople, selectedId, selected]);

  // Clear only when switching people; the chat id changing from pending to confirmed must not blank the thread.
  useEffect(() => { setMessages([]); }, [selectedId]);

  useEffect(() => {
    if (!db || !selectedChatId) return;
    return onSnapshot(query(collection(db, "chats", selectedChatId, "messages"), orderBy("createdAt", "desc"), limit(100)), (snapshot) => {
      setMessages(snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as Message)).reverse());
      setError("");
    }, () => setError("Could not load this conversation."));
  }, [selectedChatId]);

  useEffect(() => {
    setHiddenIds([]);
    setMenuFor(null);
    if (!db || !selectedChatId) return;
    return onSnapshot(doc(db, "chats", selectedChatId, "hidden", user.uid), (snapshot) => {
      const ids = snapshot.data()?.ids;
      setHiddenIds(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
    }, () => setHiddenIds([]));
  }, [selectedChatId, user.uid]);

  const lastScrolledId = useRef<string | null>(null);
  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    const switched = lastScrolledId.current !== selectedId;
    lastScrolledId.current = selectedId;
    thread.scrollTo({ top: thread.scrollHeight, behavior: switched ? "auto" : "smooth" });
  }, [messages.length, selectedId]);

  const needsRead = Boolean(selectedChat && isUnread(selectedChat, user.uid));
  useEffect(() => {
    if (!db || !selectedChatId || !needsRead) return;
    void updateDoc(doc(db, "chats", selectedChatId), { [`readAt.${user.uid}`]: serverTimestamp() }).catch(() => undefined);
  }, [selectedChatId, needsRead, messages.length, user.uid]);

  useEffect(() => {
    if (picker !== "gif") return;
    if (!giphyKey) {
      setGifResults([]);
      setGifSearchStatus("unavailable");
      return;
    }
    const controller = new AbortController();
    setGifResults([]);
    setGifSearchStatus("loading");
    const timer = window.setTimeout(async () => {
      try {
        const term = gifQuery.trim();
        const endpoint = term ? "search" : "trending";
        const url = `https://api.giphy.com/v1/gifs/${endpoint}?api_key=${encodeURIComponent(giphyKey)}&limit=18&rating=g${term ? `&q=${encodeURIComponent(term)}` : ""}`;
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error("GIF search failed.");
        const body = await response.json() as { data?: { id: string; images?: { fixed_height?: { url?: string } } }[] };
        const results = (body.data ?? []).flatMap((item) => item.images?.fixed_height?.url ? [{ id: item.id, url: item.images.fixed_height.url }] : []);
        setGifResults(results);
        setGifSearchStatus(results.length ? "results" : "empty");
      } catch {
        if (!controller.signal.aborted) {
          setGifResults([]);
          setGifSearchStatus("error");
        }
      }
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [picker, gifQuery]);

  async function send(kind: MessageKind, text: string) {
    const value = text.trim();
    if (!db || !selected || !value || sending) return;
    if (value.length > MAX_TEXT) { setError(`Messages can contain up to ${MAX_TEXT} characters.`); return; }
    if (kind === "gif" && !isHttpsUrl(value)) { setError("Enter a valid https link to a GIF."); return; }
    setSending(true);
    setError("");
    try {
      const chatId = chatIdFor(user.uid, selected.id);
      const chatRef = doc(db, "chats", chatId);
      const batch = writeBatch(db);
      batch.set(chatRef, {
        members: [user.uid, selected.id].sort(),
        lastText: kind === "text" ? value.slice(0, 120) : kind === "sticker" ? "Sent a sticker" : "Sent a GIF",
        lastSenderId: user.uid,
        lastAt: serverTimestamp(),
        readAt: { [user.uid]: serverTimestamp() },
      }, { merge: true });
      batch.set(doc(collection(chatRef, "messages")), {
        senderId: user.uid, kind, text: value, createdAt: serverTimestamp(),
        ...(replyTo ? { replyTo: { id: replyTo.id, senderId: replyTo.senderId, kind: replyTo.kind, text: replyTo.kind === "text" ? replyTo.text.slice(0, 120) : replyTo.kind === "sticker" ? "Sticker" : "GIF" } } : {}),
      });
      await batch.commit();
      if (kind === "text") setDraft("");
      setReplyTo(null);
      setPicker(null);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not send the message (${code}).` : "Could not send the message.");
    } finally {
      setSending(false);
    }
  }

  const clearedAtMs = millis(selectedChat?.clearedAt?.[user.uid]);
  const shownMessages = messages.filter((message) => !hiddenIds.includes(message.id) && (!message.createdAt || millis(message.createdAt) > clearedAtMs));

  async function clearChat() {
    if (!db || !selectedChatId) return;
    setClearing(true);
    setError("");
    try {
      await updateDoc(doc(db, "chats", selectedChatId), { [`clearedAt.${user.uid}`]: serverTimestamp(), [`readAt.${user.uid}`]: serverTimestamp() });
      setReplyTo(null);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not delete the chat (${code}).` : "Could not delete the chat.");
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  }

  async function react(message: Message, key: string) {
    if (!db || !selectedChatId) return;
    setMenuFor(null);
    setError("");
    const mine = message.reactions?.[user.uid];
    try {
      const messageRef = doc(db, "chats", selectedChatId, "messages", message.id);
      const reaction = { [`reactions.${user.uid}`]: mine === key ? deleteField() : key };
      if (mine === key || message.senderId === user.uid) {
        await updateDoc(messageRef, reaction);
      } else {
        // A new reaction on someone else's message counts as a new message so the sender is notified.
        const emoji = reactionOptions.find((option) => option.key === key)?.emoji ?? "";
        const batch = writeBatch(db);
        batch.update(messageRef, reaction);
        batch.update(doc(db, "chats", selectedChatId), { lastText: `Reacted ${emoji} to a message`, lastSenderId: user.uid, lastAt: serverTimestamp(), [`readAt.${user.uid}`]: serverTimestamp() });
        await batch.commit();
      }
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not react to the message (${code}).` : "Could not react to the message.");
    }
  }

  async function hideMessage(message: Message) {
    if (!db || !selectedChatId) return;
    setMenuFor(null);
    setError("");
    try {
      await setDoc(doc(db, "chats", selectedChatId, "hidden", user.uid), { ids: arrayUnion(message.id) }, { merge: true });
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not hide the message (${code}).` : "Could not hide the message.");
    }
  }

  async function removeMessage(message: Message) {
    if (!db || !selectedChatId) return;
    setDeleting(true);
    setError("");
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, "chats", selectedChatId, "messages", message.id), { deleted: true, kind: "text", text: "" });
      if (messages[messages.length - 1]?.id === message.id) batch.update(doc(db, "chats", selectedChatId), { lastText: "Message deleted" });
      await batch.commit();
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not delete the message (${code}).` : "Could not delete the message.");
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  }

  function formatTime(value?: Timestamp | null) {
    const date = value?.toDate?.();
    if (!date) return "";
    const sameDay = date.toDateString() === new Date().toDateString();
    return new Intl.DateTimeFormat("en-PH", sameDay ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
  }

  return <section className={`messenger${selected ? " has-selected" : ""}`} aria-label="Messenger">
    <aside className="messenger-people">
      <header><h2>Messages</h2></header>
      <div className="messenger-filters">
        <label>Search by Name<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by Name" /></label>
        <label>Filter by Division<select value={divisionFilter} onChange={(event) => { setDivisionFilter(event.target.value); setUnitFilter(allUnitsFilter); }}><option value={allDivisionsFilter}>All Divisions</option>{divisionOptions.map((division) => <option key={division} value={division}>{division}</option>)}</select></label>
        <label>Filter by Unit / Program / Project<select value={unitFilter} onChange={(event) => setUnitFilter(event.target.value)}><option value={allUnitsFilter}>All Units / Programs / Projects</option>{unitOptions.map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select></label>
      </div>
      <ul className="messenger-people-list">
        {!loadingPeople && visiblePeople.length === 0 && <li className="messenger-empty">No people match your search.</li>}
        {visiblePeople.map((person) => {
          const chat = chatByPerson.get(person.id);
          const unread = chat ? isUnread(chat, user.uid) : false;
          return <li key={person.id}><button type="button" className={`messenger-person${selectedId === person.id ? " active" : ""}${unread ? " unread" : ""}`} onClick={() => { setSelectedId(person.id); setPicker(null); setReplyTo(null); setError(""); }}>
            <PersonAvatar person={person} />
            <span className="messenger-person-text"><strong>{person.name}</strong><small>{chat && lastVisibleAt(chat) > 0 && chat.lastText ? `${chat.lastSenderId === user.uid ? "You: " : ""}${chat.lastText}` : [unitLabel(person.division, person.unit), person.position].filter(Boolean).join(" · ")}</small></span>
            {unread && <span className="messenger-unread-dot" aria-label="Unread" />}
          </button></li>;
        })}
        {loadingPeople && <li className="messenger-empty">Loading people…</li>}
      </ul>
    </aside>
    <div className="messenger-chat">
      {!selected ? <div className="messenger-placeholder"><strong>Select a person</strong><p>Choose someone from the list to start a conversation.</p></div> : <>
        <header className="messenger-chat-header">
          <button type="button" className="messenger-back" onClick={() => setSelectedId(null)} aria-label="Back to people">‹</button>
          <PersonAvatar person={selected} />
          <div><strong>{selected.name}</strong><small>{[selected.position, unitLabel(selected.division, selected.unit)].filter(Boolean).join(" · ")}</small></div>
          {selectedChat && <button type="button" className="ghost-button messenger-delete-chat" onClick={() => setConfirmClear(true)}>Delete chat</button>}
        </header>
        <div className="messenger-thread" ref={threadRef}>
          {shownMessages.length === 0 && <p className="messenger-empty">No messages yet. Say hello!</p>}
          {shownMessages.map((message) => {
            const mine = message.senderId === user.uid;
            return <div className={`messenger-message${mine ? " mine" : ""}`} key={message.id}>
              {!mine && <PersonAvatar person={selected} className="messenger-message-avatar" />}
              {message.replyTo && !message.deleted && <span className="messenger-reply-quote"><b>{message.replyTo.senderId === user.uid ? "You" : selected.name}</b>{message.replyTo.text}</span>}
              <div className="messenger-message-row" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuFor(null); }}>
                <span className={`messenger-actions${menuFor?.endsWith(`:${message.id}`) ? " is-open" : ""}`}>
                  <span className="messenger-action-wrap">
                    <button type="button" className="messenger-action" aria-label="More actions" title="More actions" aria-expanded={menuFor === `more:${message.id}`} onClick={() => setMenuFor((current) => current === `more:${message.id}` ? null : `more:${message.id}`)}>&#8942;</button>
                    {menuFor === `more:${message.id}` && <span className="messenger-menu" role="menu"><button type="button" role="menuitem" onClick={() => void hideMessage(message)}>Hide for me</button>{mine && !message.deleted && <button type="button" role="menuitem" onClick={() => { setMenuFor(null); setPendingDelete(message); }}>Delete for everyone</button>}</span>}
                  </span>
                  {!message.deleted && <button type="button" className="messenger-action" aria-label="Reply to this message" title="Reply" onClick={() => { setReplyTo(message); setMenuFor(null); }}>&#8617;</button>}
                  {!message.deleted && <span className="messenger-action-wrap">
                    <button type="button" className="messenger-action" aria-label="React" title="React" aria-expanded={menuFor === `react:${message.id}`} onClick={() => setMenuFor((current) => current === `react:${message.id}` ? null : `react:${message.id}`)}>&#9786;</button>
                    {menuFor === `react:${message.id}` && <span className="messenger-menu messenger-reaction-bar" role="menu">{reactionOptions.map((option) => <button type="button" key={option.key} role="menuitem" title={option.label} aria-label={option.label} className={message.reactions?.[user.uid] === option.key ? "is-mine" : ""} onClick={() => void react(message, option.key)}>{option.emoji}</button>)}</span>}
                  </span>}
                </span>
                {message.deleted ? <span className="messenger-deleted">{mine ? "You deleted a message." : `${selected.name} deleted a message.`}</span> : message.kind === "sticker" ? <span className="messenger-sticker">{message.text}</span>
                  : message.kind === "gif" ? isHttpsUrl(message.text) ? <img className="messenger-gif" src={message.text} alt="GIF" referrerPolicy="no-referrer" loading="lazy" /> : null
                  : <span className="messenger-bubble">{linkify(message.text)}</span>}
              </div>
              {message.kind === "text" && !message.deleted && firstUrl(message.text) && <LinkPreview url={firstUrl(message.text) as string} />}
              {Object.keys(message.reactions ?? {}).length > 0 && !message.deleted && <span className="messenger-reactions">{reactionOptions.map((option) => { const count = Object.values(message.reactions ?? {}).filter((value) => value === option.key).length; return count > 0 ? <button type="button" key={option.key} className={message.reactions?.[user.uid] === option.key ? "is-mine" : ""} title={option.label} onClick={() => void react(message, option.key)}>{option.emoji}{count > 1 ? ` ${count}` : ""}</button> : null; })}</span>}
              <small>{formatTime(message.createdAt)}</small>
            </div>;
          })}
        </div>
        {error && <p className="messenger-error" role="alert">{error}</p>}
        {picker && <div className="messenger-picker">
          {picker === "emoji" && <div className="messenger-emoji-grid">{emojis.map((emoji) => <button type="button" key={emoji} onClick={() => setDraft((current) => `${current}${emoji}`)}>{emoji}</button>)}</div>}
          {picker === "sticker" && <div className="messenger-sticker-grid">{stickers.map((sticker) => <button type="button" key={sticker} onClick={() => void send("sticker", sticker)} disabled={sending}>{sticker}</button>)}</div>}
          {picker === "gif" && <>
            <input type="search" value={gifQuery} onChange={(event) => setGifQuery(event.target.value)} placeholder="Search GIFs" aria-label="Search GIFs" disabled={!giphyKey} />
            {!giphyKey ? <p className="messenger-gif-status" role="status">GIF search is unavailable. Configure NEXT_PUBLIC_GIPHY_API_KEY to enable search.</p> : <>
              {gifSearchStatus === "loading" && <p className="messenger-gif-status" role="status">Searching GIFs…</p>}
              {gifSearchStatus === "empty" && <p className="messenger-gif-status" role="status">No GIFs found. Try another search.</p>}
              {gifSearchStatus === "error" && <p className="messenger-gif-status" role="alert">GIF search failed. Try again.</p>}
              <div className="messenger-gif-grid">{gifResults.map((gif) => <button type="button" key={gif.id} onClick={() => void send("gif", gif.url)} disabled={sending}><img src={gif.url} alt="GIF result" referrerPolicy="no-referrer" loading="lazy" /></button>)}</div>
            </>}
          </>}
        </div>}
        {replyTo && <div className="messenger-reply-bar"><span>Replying to <b>{replyTo.senderId === user.uid ? "yourself" : selected.name}</b><em>{replyTo.kind === "text" ? replyTo.text : replyTo.kind === "sticker" ? "Sticker" : "GIF"}</em></span><button type="button" aria-label="Cancel reply" onClick={() => setReplyTo(null)}>×</button></div>}
        <form className="messenger-composer" onSubmit={(event) => { event.preventDefault(); void send("text", draft); }}>
          <button type="button" className={`messenger-tool${picker === "emoji" ? " active" : ""}`} aria-label="Emoji" title="Emoji" onClick={() => setPicker((current) => current === "emoji" ? null : "emoji")}>😊</button>
          <button type="button" className={`messenger-tool${picker === "sticker" ? " active" : ""}`} aria-label="Stickers" title="Stickers" onClick={() => setPicker((current) => current === "sticker" ? null : "sticker")}>🏷️</button>
          <button type="button" className={`messenger-tool messenger-tool-gif${picker === "gif" ? " active" : ""}`} aria-label="GIF" title="GIF" onClick={() => setPicker((current) => current === "gif" ? null : "gif")}>GIF</button>
          <input value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={MAX_TEXT} placeholder="Type a message" aria-label="Message" autoComplete="off" />
          <button className="primary-button" disabled={sending || !draft.trim()}>Send</button>
        </form>
      </>}
    </div>
    <DeleteConfirmation open={confirmClear} title="Delete chat?" description={`This deletes your copy of the conversation with ${selected?.name ?? "this person"}. They keep theirs, and this cannot be undone.`} busy={clearing} onCancel={() => setConfirmClear(false)} onConfirm={() => void clearChat()} />
    <DeleteConfirmation open={pendingDelete !== null} title="Delete message for everyone?" description={'The message will be replaced with "You deleted a message." for everyone in the conversation. This cannot be undone.'} busy={deleting} onCancel={() => setPendingDelete(null)} onConfirm={() => { if (pendingDelete) void removeMessage(pendingDelete); }} />
  </section>;
}
