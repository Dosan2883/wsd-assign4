import { AppError, missing, forbidden, invalidState } from './errors.js';

const SQLITE_CONSTRAINT_UNIQUE = 2067;
const alreadyApplied = () => new AppError(409, 'ALREADY_APPLIED', '이미 해당 행사에 신청했습니다.');

export function createApplicationService(repo) {
  const { db } = repo;

  function inTransaction(work) {
    // 검사 전에 쓰기 잠금을 확보해 여러 서버도 같은 정원과 신청 상태를 기준으로 처리합니다.
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  function requireApplication(applicationId) {
    const application = repo.application(applicationId);
    if (!application) throw missing('신청');
    return application;
  }

  function requireManagedEvent(actor, eventId) {
    const event = repo.event(eventId);
    if (actor.role !== 'MANAGER' || event.managerId !== actor.id) throw forbidden();
    return event;
  }

  return {
    apply(actor, eventId) {
      return inTransaction(() => {
        if (!repo.event(eventId)) throw missing('행사');
        if (actor.role !== 'STUDENT') throw forbidden();
        if (repo.existing(eventId, actor.id)) throw alreadyApplied();

        let application;
        try {
          application = repo.insert(eventId, actor.id);
        } catch (error) {
          if (error.errcode === SQLITE_CONSTRAINT_UNIQUE) throw alreadyApplied();
          throw error;
        }
        repo.addHistory({
          applicationId: application.id,
          actorId: actor.id,
          action: 'APPLY',
          toStatus: application.status
        });
        return application;
      });
    },
    cancel(actor, applicationId) {
      return inTransaction(() => {
        const application = requireApplication(applicationId);
        if (actor.role !== 'STUDENT' || application.userId !== actor.id) throw forbidden();
        if (application.status !== 'PENDING') throw invalidState();

        const updated = repo.setStatus(applicationId, 'CANCELLED');
        repo.addHistory({
          applicationId,
          actorId: actor.id,
          action: 'CANCEL',
          fromStatus: application.status,
          toStatus: updated.status
        });
        return updated;
      });
    },
    approve(actor, applicationId) {
      return inTransaction(() => {
        const application = requireApplication(applicationId);
        const event = requireManagedEvent(actor, application.eventId);
        if (application.status !== 'PENDING') throw invalidState();
        if (repo.approvedCount(event.id) >= event.capacity) {
          throw new AppError(409, 'CAPACITY_FULL', '행사 정원이 모두 찼습니다.');
        }

        const updated = repo.setStatus(applicationId, 'APPROVED');
        repo.addHistory({
          applicationId,
          actorId: actor.id,
          action: 'APPROVE',
          fromStatus: application.status,
          toStatus: updated.status
        });
        return updated;
      });
    },
    revoke(actor, applicationId, reason) {
      return inTransaction(() => {
        const application = requireApplication(applicationId);
        const event = requireManagedEvent(actor, application.eventId);
        if (application.status !== 'APPROVED') throw invalidState();

        const revoked = repo.setStatus(applicationId, 'REVOKED');
        const revokeHistoryId = repo.addHistory({
          applicationId,
          actorId: actor.id,
          action: 'REVOKE',
          fromStatus: application.status,
          toStatus: revoked.status,
          reason
        });

        const nextPendingId = db.prepare(`SELECT id FROM applications
          WHERE event_id = ? AND status = 'PENDING'
          ORDER BY created_at ASC, id ASC
          LIMIT 1`).get(event.id)?.id;
        if (nextPendingId === undefined) return { revoked, promoted: null };

        const promoted = repo.setStatus(nextPendingId, 'APPROVED');
        repo.addHistory({
          applicationId: nextPendingId,
          actorId: actor.id,
          action: 'AUTO_APPROVE',
          fromStatus: 'PENDING',
          toStatus: promoted.status,
          causeHistoryId: revokeHistoryId
        });
        return { revoked, promoted };
      });
    }
  };
}
