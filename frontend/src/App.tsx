import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { ProtectedRoute } from './components/ProtectedRoute';
import { NotificationPanel } from './components/NotificationPanel';
import { WebSocketProvider } from './context/WebSocketContext';
import { DashboardPage } from './pages/DashboardPage';
import { HabitDetailPage } from './pages/HabitDetailPage';
import { LoginPage } from './pages/LoginPage';

/**
 * Route layout (SPEC §9):
 *   /login            → LoginPage
 *   /                 → DashboardPage (protected)
 *   /habits/:id       → HabitDetailPage (protected)
 *
 * The authenticated app is wrapped in `WebSocketProvider` so `NotificationPanel`
 * renders globally on top of any page. `NotificationPanel` and the provider only
 * mount when a user is present.
 */
function AppRoutes() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  // If a signed-in user lands on /login, send them straight to the dashboard.
  useEffect(() => {
    if (isAuthenticated && location.pathname === '/login') {
      window.location.replace('/');
    }
  }, [isAuthenticated, location.pathname]);

  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <WebSocketProvider>
                <NotificationPanel />
                <DashboardPage />
              </WebSocketProvider>
            </ProtectedRoute>
          }
        />
        <Route
          path="/habits/:id"
          element={
            <ProtectedRoute>
              <WebSocketProvider>
                <NotificationPanel />
                <HabitDetailPage />
              </WebSocketProvider>
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

export default function App() {
  return <AppRoutes />;
}
