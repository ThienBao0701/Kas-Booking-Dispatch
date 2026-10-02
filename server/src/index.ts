import type { Server } from 'node:http';
import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './db/prisma';
import { ensureInitialAdmin } from './auth/bootstrapAdmin';

async function start(): Promise<void> {
  // Fail fast: a server that cannot reach its database should not accept traffic.
  await prisma.$connect();

  // Create the initial administrator once, if configured. Never overwrites an
  // existing account; in production a missing configuration throws here.
  const bootstrap = await ensureInitialAdmin();
  if (bootstrap.created) {
    // eslint-disable-next-line no-console
    console.log('Đã tạo tài khoản quản trị viên ban đầu (bắt buộc đổi mật khẩu ở lần đăng nhập đầu).');
  } else if (bootstrap.reason === 'missing-config') {
    // eslint-disable-next-line no-console
    console.warn(
      'Bỏ qua tạo tài khoản quản trị viên: chưa cấu hình INITIAL_ADMIN_USERNAME/PASSWORD/FULL_NAME.',
    );
  }

  const app = createApp();

  // 0.0.0.0 so receptionists on the local network can reach the app.
  const server: Server = app.listen(env.PORT, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(
      `hotel-booking-dispatch server đang chạy tại http://localhost:${env.PORT} (${env.NODE_ENV})`,
    );
  });

  registerShutdown(server);
}

/**
 * Graceful shutdown, however it is asked for.
 *
 * ON WINDOWS, SIGNALS ARE NOT ENOUGH. Windows has no POSIX signals: a parent
 * calling `child.kill('SIGTERM')` invokes TerminateProcess and the handler
 * below never runs — verified directly, the handler did not fire while an IPC
 * message ran it and exited 0. So a process supervised by the production runner
 * is asked to stop over its IPC channel instead, and that request lands in the
 * same shutdown path as Ctrl+C. Without this the runner's only way to stop the
 * server would be to kill it mid-write.
 *
 * The signal handlers stay: they are what works when a developer presses Ctrl+C
 * and what would work if this ever ran anywhere but Windows.
 */
function registerShutdown(server: Server): void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    // eslint-disable-next-line no-console
    console.log(`\nNhận tín hiệu ${signal}, đang tắt server...`);

    // Keep-alive sockets that are sitting idle would otherwise hold the close
    // open until the force-exit timer fires, turning every clean shutdown into
    // a ten-second wait and then a kill. In-flight requests are NOT affected:
    // only genuinely idle connections are closed.
    server.closeIdleConnections?.();

    // Stop accepting connections, then release the database handle.
    server.close((closeError) => {
      void prisma
        .$disconnect()
        .catch(() => undefined)
        .finally(() => {
          process.exit(closeError ? 1 : 0);
        });
    });

    // Do not hang forever on lingering keep-alive sockets.
    const forceExit = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.error('Tắt server quá thời gian chờ, buộc thoát.');
      process.exit(1);
    }, 10_000);
    forceExit.unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Present only when a parent spawned this process with an IPC channel, which
  // is exactly the production runner. The payload is deliberately trivial: this
  // channel carries one instruction and must never become a control API.
  process.on('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null && (message as { type?: string }).type === 'shutdown') {
      shutdown('yêu cầu dừng từ runner');
    }
  });
}

start().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Không thể khởi động server:', error);
  process.exit(1);
});
