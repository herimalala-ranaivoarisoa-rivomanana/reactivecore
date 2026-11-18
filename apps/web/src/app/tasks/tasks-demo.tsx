"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ReactiveCoreClient, ReactiveCoreError, type Snapshot } from "../../../../../packages/client/src/client";
import { browserQueue, tokenFingerprint } from "../offline-store";
import styles from "../inventory/inventory.module.css";

interface Task {
  id: string;
  title: string;
}

interface Session {
  token: string;
  scope: string;
}

const statusNames = {
  pending: "En attente",
  sending: "Synchronisation",
  retry: "À réessayer",
  cancelled: "Annulée",
  conflict: "Conflit",
  rejected: "Refusée",
  confirmed: "Confirmée",
};

async function authenticate(token: string): Promise<Session> {
  const key = `reactivecore.tasks.identity:${await tokenFingerprint(token)}`;
  let response: Response | undefined;
  try {
    response = await fetch("/api/v1/session", {
      headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(4000),
    });
  } catch {}

  if (response?.ok) {
    const { issuer, audience, tenantId, userId, scopes } = await response.json();
    if (audience !== "tasks:lab" || !["subscribe", "mutation"].every((scope) => scopes.includes(scope))) {
      throw new Error("Ce jeton ne donne pas accès au laboratoire Tâches.");
    }
    const scope = JSON.stringify([issuer, audience, tenantId, userId]);
    localStorage.setItem(key, scope);
    return { token, scope };
  }

  if (response && response.status < 500) {
    throw new Error("Jeton invalide ou expiré.");
  }
  const cached = localStorage.getItem(key);
  if (cached) return { token, scope: cached };
  throw new Error("Connectez-vous une première fois en ligne avec ce jeton.");
}

function Workspace({ session, disconnect }: { session: Session; disconnect: () => void }) {
  const { token, scope } = session;
  const queue = useMemo(() => browserQueue<Task>("reactivecore-tasks", scope), [scope]);
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof queue.list>>>([]);
  const [snapshot, setSnapshot] = useState<Snapshot<Task[]> | null>(null);
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState("Connexion…");
  const [problem, setProblem] = useState("");
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const wake = useRef<() => void>(() => {});

  useEffect(() => {
    const abort = new AbortController();
    const client = new ReactiveCoreClient(location.origin, () => token);
    const cache = `reactivecore.tasks.snapshot:${scope}`;
    let busy = false;
    let revision = 0;
    let authorized = true;
    const live = () => !abort.signal.aborted;

    async function listen() {
      await Promise.resolve();
      if (!live()) return;
      try {
        const saved = localStorage.getItem(cache);
        if (saved) setSnapshot(JSON.parse(saved));
      } catch {}
      setStatus(navigator.onLine ? "Connexion…" : "Hors ligne");
      try {
        for await (const next of client.subscribe<Task[]>("tasks.list", {}, abort.signal, (state) => {
          if (live()) setStatus(navigator.onLine ? (state === "live" ? "En direct" : "Reconnexion…") : "Hors ligne");
        })) {
          if (!live()) return;
          setSnapshot(next);
          setStatus(navigator.onLine ? "En direct" : "Hors ligne");
          try { localStorage.setItem(cache, JSON.stringify(next)); } catch {}
        }
      } catch {
        if (!live()) return;
        authorized = false;
        setStatus("Accès expiré ou refusé");
      }
    }

    async function refresh() {
      const current = ++revision;
      try {
        const items = await queue.list();
        if (live() && current === revision) setEntries(items);
      } catch {
        if (live()) setProblem("Stockage local indisponible.");
      }
    }

    async function sync() {
      if (!live() || busy) return;
      busy = true;
      try {
        await refresh();
        await queue.sync(async (entry) => {
          try {
            const receipt = await client.mutate<Task>(
              "tasks.create", entry.args, entry.key, AbortSignal.timeout(10_000),
            );
            return { state: "confirmed", commitSeq: receipt.commitSeq };
          } catch (error) {
            if (error instanceof ReactiveCoreError) {
              if (error.status === 409) return { state: "conflict", message: "Identifiant déjà utilisé." };
              if ([400, 422].includes(error.status)) return { state: "rejected", message: "Tâche refusée." };
              if ([401, 403].includes(error.status)) {
                authorized = false;
                if (live()) setStatus("Reconnectez-vous pour synchroniser");
              }
            }
            return { state: "retry", message: "En attente de confirmation." };
          }
        }, () => live() && authorized && navigator.onLine, () => { void refresh(); });
      } catch {
        if (live()) setProblem("Synchronisation locale indisponible.");
      } finally {
        busy = false;
      }
    }

    const tick = () => { void refresh(); void sync(); };
    const offline = () => { if (live()) setStatus("Hors ligne"); };
    const online = () => { if (live()) setStatus("Reconnexion…"); tick(); };
    wake.current = tick;
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    const timer = setInterval(tick, 1000);
    void listen();
    tick();
    return () => {
      abort.abort();
      clearInterval(timer);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      wake.current = () => {};
    };
  }, [queue, scope, token]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = title.trim();
    if (!value || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    try {
      await queue.enqueue({ id: crypto.randomUUID(), title: value });
      setTitle("");
      wake.current();
    } catch {
      setProblem("Impossible d’enregistrer cette tâche sur cet appareil.");
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  async function cancel(key: string) {
    try {
      if (!(await queue.cancel(key))) setProblem("L’envoi de cette tâche a déjà commencé.");
      wake.current();
    } catch {
      setProblem("Impossible d’annuler cette tâche.");
    }
  }

  const visible = snapshot?.data ?? [];
  const ids = new Set(visible.map((task) => task.id));
  const local = entries.filter((entry) => !ids.has(entry.args.id) && (
    entry.state !== "confirmed" || !snapshot || !entry.commitSeq || BigInt(snapshot.seq) < BigInt(entry.commitSeq)
  )).reverse();
  return (
    <>
      <p className={styles.status} role="status">{status}</p>
      <form className={styles.panel + " " + styles.form} onSubmit={create}>
        <label>Nouvelle tâche<input required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <button type="submit" disabled={saving}>Ajouter la tâche</button>
      </form>
      {problem && <p role="status">{problem}</p>}
      <section className={styles.panel}>
        <h2>Liste des tâches</h2>
        <ul className={styles.history}>
          {local.map((entry) => (
            <li key={entry.args.id}>
              {entry.args.title} · <strong>{statusNames[entry.state]}</strong>
              {entry.message && <p>{entry.message}</p>}
              {entry.state === "pending" && <button type="button" onClick={() => void cancel(entry.key)}>Annuler</button>}
            </li>
          ))}
          {visible.map((task) => <li key={task.id}>{task.title} · Confirmée</li>)}
          {!local.length && !visible.length && <li>Aucune tâche à afficher.</li>}
        </ul>
      </section>
      <button className={styles.disconnect} onClick={disconnect}>Se déconnecter</button>
    </>
  );
}

export function TasksDemo() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/inventory-offline.js", { scope: "/tasks" }).catch(() => {});
    }
  }, []);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setConnecting(true);
    setError("");
    try {
      const value = new FormData(event.currentTarget).get("token");
      if (typeof value === "string") setSession(await authenticate(value.trim()));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Connexion impossible.");
    } finally {
      setConnecting(false);
    }
  }

  return (
    <main className={styles.page}>
      <Link href="/" className={styles.back}>← ReactiveCore</Link>
      <h1>Tâches hors ligne</h1>
      <p className={styles.intro}>Ajoutez une tâche même sans réseau. Son état indique quand le serveur l’a confirmée.</p>
      {session ? <Workspace session={session} disconnect={() => setSession(null)} /> : (
        <form className={styles.panel + " " + styles.form} onSubmit={connect}>
          <label>Jeton JWT Tâches<input name="token" type="password" required autoComplete="off" /></label>
          <button disabled={connecting}>Ouvrir les tâches</button>
          {error && <p role="status">{error}</p>}
        </form>
      )}
    </main>
  );
}
