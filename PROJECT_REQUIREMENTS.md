# FREP Project Requirements

## Objective

FREP enables MSMEs to discover, share, verify, and book underused industrial resources across manufacturing clusters in India.

## Users and permissions

| User | Primary capabilities |
| --- | --- |
| Buyer | Search resources, receive match suggestions, create single or bundled booking requests, and review bookings. |
| Resource owner | Add, update, or remove their own listings and view their listings. |
| Network admin | Review pending listings and approve or reject their verification status. |

## Functional requirements

1. The platform must show searchable resources with category, location, daily price, availability, rating, and verification status.
2. Location inputs must provide a maintained directory of industrial clusters, with city and state context.
3. Search and planning inputs must provide suggestions from the current catalogue.
4. Buyers must be able to filter by resource type, cluster, budget, deadline, availability, and verification status.
5. Buyers must be able to submit individual and bundled booking requests.
6. Owners must be able to create listings that enter a pending-verification state.
7. Admins must be able to approve or reject listings.
8. The production planner must recommend a resource chain based on material, processes, quantity, budget, deadline, and preferred cluster.
9. The dashboard must expose inventory, booking, verification, cost, and sustainability indicators.
10. The system must retain resources, bookings, notifications, production requests, and cluster data in SQLite.

## Cluster directory scope

The starter directory includes 25 major Indian industrial and MSME hubs across the North, South, East, West, and Central regions. It is a selectable location catalogue, not a claim that every hub currently has listed capacity. Resource owners can still add a new cluster when needed.

## Quality requirements

- The app must run locally with Flask and SQLite.
- API responses must be JSON and support the frontend workflows.
- Inputs must use browser validation for mandatory fields and numeric limits.
- Listing verification must be explicit; a new listing is not verified by default.
- The prototype must not be used as a production marketplace without authentication, authorization, audit logging, payment controls, and security review.
