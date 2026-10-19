import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "./api.ts";
import { App } from "./App.tsx";
import "./styles.css";

// While logged in, a 401 anywhere means the session ended (expired, logged out
// elsewhere, user disabled): re-check "me", which drops the app back to the
// login page. Only while logged in: a wrong password is also a 401, and "me"
// itself 401s for every logged-out visitor.
const sessionEnded = (err: unknown) =>
  err instanceof ApiError && err.status === 401 && queryClient.getQueryData(["me"]) !== undefined;
const recheckMe = () => void queryClient.invalidateQueries({ queryKey: ["me"] });
const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (err, query) => {
      if (sessionEnded(err) && query.queryKey[0] !== "me") recheckMe();
    },
  }),
  mutationCache: new MutationCache({
    onError: (err) => {
      if (sessionEnded(err)) recheckMe();
    },
  }),
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
