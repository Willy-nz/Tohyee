"use client";

import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Card, Notice, ui } from "@/components/ui";
import { ROLE_LABELS, type Role } from "@/lib/auth/roles";
import { api, errorMessage } from "@/lib/client/api";
import type { MemberFarmAccess } from "@/lib/farming/access";
import type { Member } from "@/lib/organisations/members";

type Answer = { farming: boolean; farms: Array<{ id: string; name: string; isActive: boolean }>; access: MemberFarmAccess[]; keptApart: boolean };

const SEE_ALL: Role[] = ["owner", "admin"];

/** Which farms each member works on (decision 744); shown on People and roles when Farming is on. */
export function MemberFarms({ organisationId, members }: { organisationId: string; members: Member[] }) {
  const loaded = useApiData<Answer>("/api/farming/member-farms", { organisationId });
  const [error, setError] = useState<string | null>(null);
  const data = loaded.data;
  if (!data || !data.farming) return null;
  const byUser = new Map(data.access.map((entry) => [entry.userId, entry]));
  const save = async (userId: string, access: MemberFarmAccess["access"], farmIds: string[] = []) => {
    setError(null);
    try {
      await api("/api/farming/member-farms", { method: "PUT", body: { organisationId, userId, access, farmIds } });
      loaded.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  const people = members.filter((member) => member.role !== "sales_rep" && member.role !== "sales_manager");
  const waiting = people.filter((member) => !SEE_ALL.includes(member.role) && !byUser.has(member.userId));
  return (
    <Card
      title="Farms each person works on"
      description="Owners and admins see every farm. With two or more farms, viewers, bookkeepers and report viewers see and record only for the farms chosen here: maps, paddocks, soil, pasture, fertiliser, the farm calendar's shared items, Home's farm cards, farm apps and AI tools. The farm notebook and Analytics' farm tables cover every farm, so they need All farms."
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!data.keptApart ? <p className={ui.muted}>There&apos;s only one farm, so everyone sees it. These choices apply once there are two or more.</p> : null}
      {data.keptApart && waiting.length ? (
        <Notice tone="warning">
          {waiting.length === 1 ? "1 person isn't" : `${waiting.length} people aren't`} assigned to any farm yet, so they see no farm records: {waiting.map((member) => member.displayName).join(", ")}.
        </Notice>
      ) : null}
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Person</th>
              <th>Farms</th>
            </tr>
          </thead>
          <tbody>
            {people.map((member) => {
              const entry = byUser.get(member.userId);
              const choice = entry?.access ?? "unassigned";
              return (
                <tr key={member.userId}>
                  <td data-label="Person">
                    {member.displayName}
                    <br />
                    <small className={ui.muted}>{ROLE_LABELS[member.role]}</small>
                  </td>
                  <td data-label="Farms">
                    {SEE_ALL.includes(member.role) ? (
                      <span>All farms ({ROLE_LABELS[member.role].toLowerCase()})</span>
                    ) : (
                      <>
                        <select
                          aria-label={`Farms for ${member.displayName}`}
                          value={choice}
                          onChange={(event) => void save(member.userId, event.target.value as MemberFarmAccess["access"], entry?.farmIds ?? [])}
                        >
                          <option value="unassigned">Not assigned yet (no farms)</option>
                          <option value="all">All farms</option>
                          <option value="farms">Only the farms ticked</option>
                        </select>{" "}
                        {choice === "unassigned" && data.keptApart ? <Badge tone="amber">Sees no farms</Badge> : null}
                        {choice === "farms" ? (
                          <fieldset style={{ border: 0, padding: 0, margin: "8px 0 0" }}>
                            <legend className={ui.muted}>Farms {member.displayName} works on</legend>
                            {data.farms.map((farm) => {
                              const ticked = entry?.farmIds.includes(farm.id) ?? false;
                              return (
                                <label key={farm.id} style={{ display: "block" }}>
                                  <input
                                    type="checkbox"
                                    checked={ticked}
                                    onChange={() => void save(member.userId, "farms", ticked ? entry!.farmIds.filter((id) => id !== farm.id) : [...(entry?.farmIds ?? []), farm.id])}
                                  />{" "}
                                  {farm.name}
                                  {farm.isActive ? "" : " (archived)"}
                                </label>
                              );
                            })}
                          </fieldset>
                        ) : null}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
