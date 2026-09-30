import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { DevToolsBar } from './DevToolsBar';
import { OfflineIndicator } from '../components/OfflineIndicator';
import { ShiftGate } from '../components/ShiftGate';
import { ChatBubble } from '../components/ChatBubble';
import { isReceptionSupervisor } from '../auth/types';
import { useAuth } from '../auth/AuthProvider';

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user } = useAuth();
  // The chat is Admin↔Reception correspondence; no other role has a part in it.
  // The branch chat: Reception, the Admin and the reception supervisors — the
  // server lists only the branches each may open (a manager: its own).
  const hasChat = user?.role === 'RECEPTIONIST' || isReceptionSupervisor(user?.role);

  return (
    <div className="flex min-h-screen bg-slate-100">
      {/* Desktop sidebar */}
      <div className="hidden lg:block">
        <Sidebar />
      </div>

      {/* Mobile drawer */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute left-0 top-0 h-full shadow-xl">
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <OfflineIndicator />
        <Topbar onOpenMenu={() => setMobileOpen(true)} />
        <DevToolsBar />
        {/*
          Shift check-in. Rendered by the SHELL so it follows the receptionist
          across every page and survives a refresh — the session is read from
          the server, never held in React state.
        */}
        <ShiftGate />
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-5xl">
            <Outlet />
          </div>
        </main>
      </div>
      {/*
        THE CHAT BUBBLE, once, for every page of both roles. Rendered by the
        shell — not by a page — so it is never unmounted by navigating, and it
        keeps the open branch, the draft and the scroll position.
      */}
      {hasChat ? <ChatBubble /> : null}
    </div>
  );
}
