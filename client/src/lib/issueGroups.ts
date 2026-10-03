/**
 * BRANCH → ROOM → INCIDENTS — one grouping for the technical report and the
 * technician's queues alike. A room is a PLACE (`issuePlace`: the room, floor or
 * fixture, without the free-text detail), so Phòng 206's four faults are one
 * group however each was described. The group is only a container: every
 * incident keeps its own state, assignment and history.
 */
import { issuePlace, type Issue } from '../api/issues';

export interface RoomGroup {
  key: string;
  /** "Phòng 206", "Hành lang · Tầng 3". */
  label: string;
  issues: Issue[];
}

export interface BranchGroup {
  branchId: number;
  branch: Issue['branch'];
  rooms: RoomGroup[];
}

export function groupIssuesByBranchRoom(issues: readonly Issue[]): BranchGroup[] {
  const branches = new Map<number, { branch: Issue['branch']; rooms: Map<string, RoomGroup> }>();
  for (const issue of issues) {
    const entry = branches.get(issue.branchId) ?? { branch: issue.branch, rooms: new Map<string, RoomGroup>() };
    const place = issuePlace(issue);
    const room = entry.rooms.get(place.key) ?? { key: place.key, label: place.label, issues: [] };
    room.issues.push(issue);
    entry.rooms.set(place.key, room);
    branches.set(issue.branchId, entry);
  }
  return [...branches.entries()]
    .sort(([, a], [, b]) => (a.branch?.branchNumber ?? 99) - (b.branch?.branchNumber ?? 99))
    .map(([branchId, g]) => ({
      branchId,
      branch: g.branch,
      rooms: [...g.rooms.values()].sort((a, b) => a.label.localeCompare(b.label, 'vi', { numeric: true })),
    }));
}
