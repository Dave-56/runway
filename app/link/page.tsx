"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  usePlaidLink,
  type PlaidLinkOnSuccess,
  type PlaidLinkOnExit,
} from "react-plaid-link";

type Status = "idle" | "loading" | "success" | "error";

function LinkFlow() {
  const searchParams = useSearchParams();
  const linkToken = searchParams.get("token");
  const userId = searchParams.get("user_id");

  const [status, setStatus] = useState<Status>("idle");

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    async (publicToken, metadata) => {
      setStatus("loading");
      try {
        const res = await fetch("/api/plaid/exchange-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            public_token: publicToken,
            user_id: userId,
          }),
        });

        if (!res.ok) {
          throw new Error("Exchange failed");
        }

        setStatus("success");
      } catch {
        setStatus("error");
      }
    },
    [userId]
  );

  const onExit = useCallback<PlaidLinkOnExit>((error) => {
    if (error) {
      setStatus("error");
    }
  }, []);

  const { open, ready, error } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit,
  });

  // Auto-open Plaid Link once the SDK is ready
  useEffect(() => {
    if (ready && linkToken && status === "idle") {
      open();
    }
  }, [ready, open, linkToken, status]);

  // Handle SDK-level errors
  useEffect(() => {
    if (error) {
      setStatus("error");
    }
  }, [error]);

  const retry = () => {
    setStatus("idle");
    if (ready) {
      open();
    }
  };

  if (!linkToken) {
    return (
      <div className="text-center">
        <p className="text-lg text-neutral-700">
          Missing link token. Ask Clearline for a new link.
        </p>
      </div>
    );
  }

  if (status === "success") {
    return (
      <div className="text-center">
        <p className="text-lg text-neutral-700">
          Accounts linked. Head back to Telegram.
        </p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="text-center space-y-4">
        <p className="text-lg text-neutral-700">
          Something went wrong. Try again.
        </p>
        <button
          onClick={retry}
          className="px-6 py-2 rounded-lg bg-neutral-900 text-white text-sm font-medium hover:bg-neutral-800 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  // Loading / waiting for Plaid Link to open
  return (
    <div className="text-center">
      <p className="text-lg text-neutral-700">Connecting to your bank...</p>
    </div>
  );
}

export default function LinkPage() {
  return (
    <main className="flex-1 flex flex-col items-center justify-center px-6 min-h-screen">
      <Suspense
        fallback={
          <div className="text-center">
            <p className="text-lg text-neutral-700">
              Connecting to your bank...
            </p>
          </div>
        }
      >
        <LinkFlow />
      </Suspense>
      <p className="absolute bottom-6 text-xs text-neutral-400">Clearline</p>
    </main>
  );
}
