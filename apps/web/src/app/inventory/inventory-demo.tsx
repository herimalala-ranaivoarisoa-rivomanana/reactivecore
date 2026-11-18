"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { mutate, useReactiveQuery } from "./use-reactive-query";
import { inventoryQueue, inventoryScope } from "./offline-inventory";
import styles from "./inventory.module.css";

const central = "22222222-2222-4222-8222-222222222222";
const destination = "66666666-6666-4666-8666-666666666666";
const medicineId = "33333333-3333-4333-8333-333333333333";

const labels = {
  live: "En direct",
  offline: "Hors ligne · dernier stock confirmé",
  connecting: "Connexion…",
  reconnecting: "Reconnexion…",
  error: "Accès refusé ou requête invalide",
};

function StockPanel({ title, stream }: { title: string; stream: ReturnType<typeof useReactiveQuery> }) {
  const row = stream.snapshot?.data.find((entry) => entry.medicineId === medicineId);
  return (
    <section className={styles.panel}>
      <h2>{title}</h2>
      <p className={styles.status} data-state={stream.state} role="status">{labels[stream.state]}</p>
      <p className={styles.amount}>{stream.snapshot ? (row?.quantity ?? 0) : "—"}</p>
      <p className={styles.detail}>
        Unités disponibles{row ? ` · Version ${row.version}` : ""}
      </p>
      {stream.snapshot && <p className={styles.detail}>Snapshot {stream.snapshot.seq}</p>}
    </section>
  );
}

function ConnectedInventory({ token, scope, disconnect }: { token: string; scope: string; disconnect: () => void }) {
  const source = useReactiveQuery("inventory.list", { pharmacyId: central }, token, scope);
  const target = useReactiveQuery("inventory.list", { pharmacyId: destination }, token, scope);
  const [quantity, setQuantity] = useState("1");
  const [reverse, setReverse] = useState(false);
  const queue = useMemo(() => inventoryQueue(scope), [scope]);
  const [operations, setOperations] = useState<Awaited<ReturnType<typeof queue.list>>>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const refresh = useRef<() => void>(() => {});
  const savingRef = useRef(false);
  const pending = operations.filter((item) => ["pending", "sending", "retry"].includes(item.state)).length;

  useEffect(() => {
    let disposed = false;
    let busy = false;
    let refreshVersion = 0;

    const list = async () => {
      const version = ++refreshVersion;
      const entries = await queue.list();
      if (!disposed && version === refreshVersion) setOperations(entries);
    };
    const notify = () => {
      void list().catch(() => {
        if (!disposed) setMessage("Le stockage local est indisponible.");
      });
    };
    const tick = async () => {
      if (disposed || busy) return;
      busy = true;
      try {
        await list();
        await queue.sync(async (operation) => {
          const { status, result } = await mutate("inventory.transfer", operation.args, token, operation.key);
          const detail = typeof result.message === "string" ? result.message : undefined;
          if (status === 200) return { state: "confirmed" };
          if (status === 409) return { state: "conflict", message: detail };
          if (status === 400 || status === 422) return { state: "rejected", message: detail };
          return { state: "retry", message: "Envoi non confirmé. La commande reste en attente." };
        }, () => !disposed && navigator.onLine, notify);
      } catch {
        if (!disposed) setMessage("Le stockage local est indisponible.");
      } finally {
        busy = false;
      }
    };

    const wake = () => { notify(); void tick(); };
    refresh.current = wake;
    window.addEventListener("online", wake);
    const timer = setInterval(() => void tick(), 1000);
    wake();
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener("online", wake);
      refresh.current = () => {};
    };
  }, [queue, token]);

  async function cancel(key: string) {
    try {
      const cancelled = await queue.cancel(key);
      setMessage(cancelled ? "Transfert annulé sur cet appareil." : "Le premier envoi a déjà commencé.");
      refresh.current();
    } catch {
      setMessage("Impossible d’annuler la commande sur cet appareil.");
    }
  }

  async function transfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await queue.enqueue({
        sourcePharmacyId: reverse ? destination : central,
        destinationPharmacyId: reverse ? central : destination,
        medicineId,
        quantity: Number(quantity),
      });
      setMessage("Transfert enregistré sur cet appareil.");
      refresh.current();
    } catch {
      setMessage("Impossible d’enregistrer le transfert sur cet appareil.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <>
      <div className={styles.grid}>
        <StockPanel title="Pharmacie centrale" stream={source} />
        <StockPanel title="Pharmacie de destination" stream={target} />
      </div>
      <form className={styles.panel + " " + styles.form} onSubmit={transfer}>
        <h2>Transférer du stock</h2>
        <label>
          Direction
          <select value={reverse ? "reverse" : "forward"} onChange={(event) => setReverse(event.target.value === "reverse")}>
            <option value="forward">Centrale → Destination</option>
            <option value="reverse">Destination → Centrale</option>
          </select>
        </label>
        <label>
          Quantité
          <input type="number" min="1" max="1000000" step="1" required value={quantity} onChange={(event) => setQuantity(event.target.value)} />
        </label>
        <button type="submit" disabled={saving}>
          {saving ? "Enregistrement…" : "Transférer"}
        </button>
        <p role="status">{pending} transfert(s) en attente de confirmation.</p>

        {message && <p role="status">{message}</p>}
      </form>
      {operations.length > 0 && (
        <section className={styles.panel}>
          <h2>Historique des transferts</h2>
          <ul className={styles.history}>
            {operations.slice().reverse().map((item) => (
              <li key={item.key}>
                {item.args.quantity} unité(s) · {item.args.sourcePharmacyId === central ? "Centrale → Destination" : "Destination → Centrale"} · {{
                  pending: "En attente",
                  sending: "Synchronisation",
                  retry: "À réessayer",
                  confirmed: "Confirmé",
                  cancelled: "Annulé",
                  conflict: "Conflit",
                  rejected: "Refusé",
                }[item.state]}
                {item.message && <p>{item.message}</p>}
                {item.state === "pending" && <button type="button" onClick={() => void cancel(item.key)}>Annuler</button>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <button className={styles.disconnect} onClick={disconnect}>Se déconnecter</button>
    </>
  );
}

export function InventoryDemo() {
  const [session, setSession] = useState<{ token: string; scope: string } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/inventory-offline.js", { scope: "/inventory" }).catch(() => {});
    }
  }, []);
  return (
    <main className={styles.page}>
      <Link href="/" className={styles.back}>← ReactiveCore</Link>
      <h1>Stocks en direct</h1>
      <p className={styles.intro}>Suivez les stocks de deux pharmacies et observez l’effet d’un transfert.</p>
      {session ? <ConnectedInventory token={session.token} scope={session.scope} disconnect={() => setSession(null)} /> : (
        <form className={styles.panel + " " + styles.form} onSubmit={(event) => {
          event.preventDefault();
          const value = new FormData(event.currentTarget).get("token");
          if (typeof value === "string" && value.trim()) {
            const token = value.trim();
            void inventoryScope(token).then((scope) => setSession({ token, scope })).catch(() => {
              setError("Ouvrez le laboratoire sur localhost ou en HTTPS pour activer le stockage hors ligne.");
            });
          }
        }}>
          <label>Jeton de développement<input name="token" type="password" required autoComplete="off" /></label>
          <button type="submit">Ouvrir le laboratoire</button>
          {error && <p role="status">{error}</p>}
        </form>
      )}
    </main>
  );
}
