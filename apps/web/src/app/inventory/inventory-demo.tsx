"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { mutate, useReactiveQuery } from "./use-reactive-query";
import styles from "./inventory.module.css";

const central = "22222222-2222-4222-8222-222222222222";
const destination = "66666666-6666-4666-8666-666666666666";
const medicineId = "33333333-3333-4333-8333-333333333333";

const labels = {
  live: "En direct",
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

function ConnectedInventory({ token, disconnect }: { token: string; disconnect: () => void }) {
  const source = useReactiveQuery("inventory.list", { pharmacyId: central }, token);
  const target = useReactiveQuery("inventory.list", { pharmacyId: destination }, token);
  const [quantity, setQuantity] = useState("1");
  const [reverse, setReverse] = useState(false);
  const [requestKey, setRequestKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  async function transfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const key = requestKey ?? crypto.randomUUID();
    setRequestKey(key);
    setPending(true);
    setMessage("");
    try {
      const { status, result } = await mutate("inventory.transfer", {
        sourcePharmacyId: reverse ? destination : central,
        destinationPharmacyId: reverse ? central : destination,
        medicineId,
        quantity: Number(quantity),
      }, token, key);
      if (status === 200) {
        setMessage(result.replayed ? "Transfert retrouvé dans le journal." : "Transfert confirmé.");
        setRequestKey(null);
      } else if (status >= 400 && status < 500 && status !== 429) {
        setMessage(typeof result.message === "string" ? result.message : "Transfert refusé.");
        setRequestKey(null);
      } else {
        setMessage("Résultat incertain. Réessayez le même transfert.");
      }
    } catch {
      setMessage("Connexion interrompue. Réessayez le même transfert.");
    } finally {
      setPending(false);
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
          <select value={reverse ? "reverse" : "forward"} disabled={!!requestKey} onChange={(event) => setReverse(event.target.value === "reverse")}>
            <option value="forward">Centrale → Destination</option>
            <option value="reverse">Destination → Centrale</option>
          </select>
        </label>
        <label>
          Quantité
          <input type="number" min="1" max="1000000" step="1" required value={quantity} disabled={!!requestKey} onChange={(event) => setQuantity(event.target.value)} />
        </label>
        <button type="submit" disabled={pending || (!requestKey && (source.state !== "live" || target.state !== "live"))}>
          {pending ? "Transfert en cours…" : requestKey ? "Réessayer le transfert" : "Transférer"}
        </button>
        {message && <p role="status">{message}</p>}
      </form>
      <button className={styles.disconnect} onClick={disconnect} disabled={!!requestKey}>Se déconnecter</button>
    </>
  );
}

export function InventoryDemo() {
  const [token, setToken] = useState("");
  return (
    <main className={styles.page}>
      <Link href="/" className={styles.back}>← ReactiveCore</Link>
      <h1>Stocks en direct</h1>
      <p className={styles.intro}>Suivez les stocks de deux pharmacies et observez l’effet d’un transfert.</p>
      {token ? <ConnectedInventory token={token} disconnect={() => setToken("")} /> : (
        <form className={styles.panel + " " + styles.form} onSubmit={(event) => {
          event.preventDefault();
          const value = new FormData(event.currentTarget).get("token");
          if (typeof value === "string" && value.trim()) setToken(value.trim());
        }}>
          <label>Jeton de développement<input name="token" type="password" required autoComplete="off" /></label>
          <button type="submit">Ouvrir le laboratoire</button>
        </form>
      )}
    </main>
  );
}
