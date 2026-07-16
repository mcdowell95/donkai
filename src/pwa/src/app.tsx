import { useEffect, useState } from "preact/hooks";
import { getToken, setUnauthorizedHandler } from "./api";
import { usePath } from "./hooks";
import { TabBar } from "./components/TabBar";
import { Home } from "./views/Home";
import { TicketDetail } from "./views/TicketDetail";
import { Queue } from "./views/Queue";
import { Settings } from "./views/Settings";
import { Costs } from "./views/Costs";
import { TokenGate } from "./views/TokenGate";

export function App() {
  const [authed, setAuthed] = useState(() => !!getToken());
  const path = usePath();

  useEffect(() => {
    setUnauthorizedHandler(() => setAuthed(false));
    return () => setUnauthorizedHandler(null);
  }, []);

  if (!authed) {
    return <TokenGate onDone={() => setAuthed(true)} />;
  }

  const ticketMatch = path.match(/^\/ticket\/([^/]+)$/);
  let view;
  if (ticketMatch) {
    const key = decodeURIComponent(ticketMatch[1]);
    view = <TicketDetail key={key} ticketKey={key} />;
  } else if (path === "/queue") {
    view = <Queue />;
  } else if (path === "/settings") {
    view = <Settings onLogout={() => setAuthed(false)} />;
  } else if (path === "/costs") {
    view = <Costs />;
  } else {
    if (path !== "/") {
      // Unknown route — snap back to home without a reload.
      history.replaceState(null, "", "/");
    }
    view = <Home />;
  }

  return (
    <>
      <main class="app-main">{view}</main>
      <TabBar path={ticketMatch ? "/" : path} />
    </>
  );
}
