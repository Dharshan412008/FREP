import { useMemo, useState } from "react";
import {
  AlertCircle,
  Boxes,
  CalendarClock,
  Check,
  CheckCircle2,
  CircleDot,
  IndianRupee,
  PackageCheck,
  Star,
  Timer,
} from "lucide-react";

const currencyFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

const activeStatuses = new Set([
  "Requested",
  "Pending Owner Approval",
  "Confirmed",
  "Capacity Reserved",
  "In Progress",
  "Ready for Delivery",
]);

const timelineStages = ["Requested", "Confirmed", "In progress", "Completed"];

function formatDate(value) {
  if (!value) return "Date pending";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

function statusTone(status) {
  if (status === "Completed") return "success";
  if (status === "Cancelled" || status === "Disputed") return "danger";
  if (status === "In Progress" || status === "Ready for Delivery") return "active";
  return "pending";
}

function timelineIndex(status) {
  if (status === "Completed") return 3;
  if (status === "In Progress" || status === "Ready for Delivery") return 2;
  if (status === "Confirmed" || status === "Capacity Reserved") return 1;
  return 0;
}

export default function BookingsPage({ bookings = [], onAction }) {
  const safeBookings = Array.isArray(bookings) ? bookings : [];
  const [filter, setFilter] = useState("all");
  const [ratings, setRatings] = useState({});
  const [working, setWorking] = useState("");
  const [message, setMessage] = useState("");

  const visibleBookings = useMemo(() => safeBookings.filter((booking) => {
    if (filter === "completed") return booking.status === "Completed";
    if (filter === "active") return activeStatuses.has(booking.status);
    return true;
  }), [filter, safeBookings]);

  const completed = safeBookings.filter((booking) => booking.status === "Completed");
  const active = safeBookings.filter((booking) => activeStatuses.has(booking.status));
  const total = safeBookings.reduce((sum, booking) => sum + (Number(booking.total) || 0), 0);
  const rated = completed.map((booking) => Number(booking.rating)).filter((value) => value >= 1 && value <= 5);
  const averageRating = rated.length ? rated.reduce((sum, value) => sum + value, 0) / rated.length : null;
  const nextBooking = active[0];

  const runAction = async (bookingId, action, rating) => {
    setWorking(`${bookingId}:${action}`);
    setMessage("");
    try {
      await onAction?.(bookingId, action, rating);
      setMessage(action === "rate" ? "Your delivery rating was recorded." : `${bookingId} was marked complete and its capacity released.`);
    } catch (error) {
      setMessage(error?.message || "That booking could not be updated. Please try again.");
    } finally {
      setWorking("");
    }
  };

  return (
    <div className="page-stack bookings-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow"><PackageCheck aria-hidden="true" /> Buyer operations</span>
          <h1>Booking control room</h1>
          <p>Track reserved capacity, close completed work, and leave a verified delivery signal.</p>
        </div>
        {nextBooking ? (
          <div className="next-booking-chip">
            <span className="next-booking-chip__icon"><Timer aria-hidden="true" /></span>
            <span><small>Currently moving</small><strong>{nextBooking.id}</strong></span>
            <span className="status-badge status-badge--active">{nextBooking.status}</span>
          </div>
        ) : null}
      </header>

      <section className="booking-summary" aria-label="Booking summary">
        <article><CalendarClock aria-hidden="true" /><div><span>Active jobs</span><strong>{active.length}</strong></div></article>
        <article><CheckCircle2 aria-hidden="true" /><div><span>Completed</span><strong>{completed.length}</strong></div></article>
        <article><IndianRupee aria-hidden="true" /><div><span>Booked value</span><strong>{currencyFormatter.format(total)}</strong></div></article>
        <article><Star aria-hidden="true" /><div><span>Average rating</span><strong>{averageRating ? averageRating.toFixed(1) : "—"}</strong></div></article>
      </section>

      <section className="panel booking-ledger" aria-labelledby="booking-ledger-title">
        <header className="booking-ledger__header">
          <div>
            <span className="eyebrow"><Boxes aria-hidden="true" /> Capacity ledger</span>
            <h2 id="booking-ledger-title">Your bookings</h2>
          </div>
          <div className="segmented-control" aria-label="Filter bookings">
            {[
              ["all", `All ${safeBookings.length}`],
              ["active", `Active ${active.length}`],
              ["completed", `Completed ${completed.length}`],
            ].map(([value, label]) => (
              <button
                className={filter === value ? "is-active" : ""}
                type="button"
                key={value}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </header>

        {message ? <div className="inline-notice" role="status"><Check aria-hidden="true" /> {message}</div> : null}

        {visibleBookings.length ? (
          <div className="booking-list">
            {visibleBookings.map((booking) => {
              const resources = Array.isArray(booking.resources) ? booking.resources : [];
              const currentStage = timelineIndex(booking.status);
              const isTerminalException = booking.status === "Cancelled" || booking.status === "Disputed";
              const chosenRating = ratings[booking.id] || 5;
              return (
                <article className="booking-card" key={booking.id}>
                  <header className="booking-card__header">
                    <div className="booking-card__identity">
                      <span className="booking-card__mark"><PackageCheck aria-hidden="true" /></span>
                      <div>
                        <span className="booking-card__reference">Booking {booking.id}</span>
                        <h3>{resources.length === 1 ? "Single-resource job" : `${resources.length} resource production bundle`}</h3>
                        <p><CalendarClock aria-hidden="true" /> Created {formatDate(booking.created)}</p>
                      </div>
                    </div>
                    <div className="booking-card__total">
                      <span className={`status-badge status-badge--${statusTone(booking.status)}`}>{booking.status || "Requested"}</span>
                      <strong>{currencyFormatter.format(Number(booking.total) || 0)}</strong>
                    </div>
                  </header>

                  {!isTerminalException ? (
                    <ol className="booking-timeline" aria-label={`Progress for ${booking.id}`}>
                      {timelineStages.map((stage, index) => (
                        <li className={index < currentStage ? "is-complete" : index === currentStage ? "is-current" : ""} key={stage}>
                          <span className="booking-timeline__dot" aria-hidden="true">{index < currentStage ? <Check /> : <CircleDot />}</span>
                          <span>{stage}</span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <div className="booking-exception"><AlertCircle aria-hidden="true" /> This booking is {booking.status.toLowerCase()} and no longer holds active capacity.</div>
                  )}

                  <div className="booking-card__body">
                    <div className="resource-token-list" aria-label="Resources in this booking">
                      <span>Resource IDs</span>
                      <div>{resources.length ? resources.map((resourceId) => <code key={resourceId}>{resourceId}</code>) : <small>No resources recorded</small>}</div>
                    </div>
                    {booking.note ? <blockquote>{booking.note}</blockquote> : null}
                  </div>

                  <footer className="booking-card__footer">
                    <div className="booking-card__buyer"><span>Booked for</span><strong>{booking.buyer || "Current buyer"}</strong></div>
                    {activeStatuses.has(booking.status) ? (
                      <button
                        className="button button--primary"
                        type="button"
                        disabled={working === `${booking.id}:complete`}
                        onClick={() => runAction(booking.id, "complete")}
                      >
                        <CheckCircle2 aria-hidden="true" />
                        {working === `${booking.id}:complete` ? "Completing…" : "Mark complete"}
                      </button>
                    ) : booking.status === "Completed" && booking.rating == null ? (
                      <div className="rating-control">
                        <fieldset>
                          <legend>Rate this delivery</legend>
                          <div className="star-picker">
                            {[1, 2, 3, 4, 5].map((rating) => (
                              <button
                                className={rating <= chosenRating ? "is-selected" : ""}
                                type="button"
                                key={rating}
                                aria-label={`${rating} star${rating === 1 ? "" : "s"}`}
                                aria-pressed={chosenRating === rating}
                                onClick={() => setRatings((current) => ({ ...current, [booking.id]: rating }))}
                              >
                                <Star aria-hidden="true" />
                              </button>
                            ))}
                          </div>
                        </fieldset>
                        <button
                          className="button button--secondary button--small"
                          type="button"
                          disabled={working === `${booking.id}:rate`}
                          onClick={() => runAction(booking.id, "rate", chosenRating)}
                        >
                          {working === `${booking.id}:rate` ? "Saving…" : "Submit rating"}
                        </button>
                      </div>
                    ) : booking.rating != null ? (
                      <span className="recorded-rating"><Star aria-hidden="true" /> {booking.rating}/5 delivery rating</span>
                    ) : null}
                  </footer>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="empty-state">
            <PackageCheck aria-hidden="true" />
            <h3>{safeBookings.length ? "No bookings in this view" : "Your capacity ledger is empty"}</h3>
            <p>{safeBookings.length ? "Choose another filter to see your jobs." : "Confirmed marketplace bookings will appear here with live status."}</p>
          </div>
        )}
      </section>
    </div>
  );
}
