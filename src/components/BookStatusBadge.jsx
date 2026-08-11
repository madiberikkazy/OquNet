import { t } from "../utils/i18n.js";

export default function BookStatusBadge({ status, daysLeft, reserved = false }) {
  if (status === "available") return <span className="pill bg-okSoft text-ok">{t.availableStatus}</span>;
  if (status === "unavailable") {
    // Off the shelf, but not being read: its owner is collecting it on the way
    // out of the community. "Unavailable" is true and useless — the person
    // holding it needs to know it is spoken for, and by whom.
    if (reserved) return <span className="pill bg-warnSoft text-warn">{t.reservedStatus}</span>;
    if (daysLeft != null && daysLeft <= 3) {
      return <span className="pill bg-warnSoft text-warn">{daysLeft} күн қалды</span>;
    }
    if (daysLeft != null) {
      return <span className="pill bg-badSoft text-bad">{daysLeft} күн қалды</span>;
    }
    return <span className="pill bg-badSoft text-bad">{t.unavailableStatus}</span>;
  }
  if (status === "soon")
    return <span className="pill bg-warnSoft text-warn">{daysLeft != null ? `${daysLeft} күн қалды` : t.soonStatus}</span>;
  return null;
}
