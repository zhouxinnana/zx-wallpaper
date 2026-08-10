# UI toggle is not a repeated command

The learner initially connected a second favorite click with cancellation. The distinction was clarified: the UI may toggle state, but the API should express that as POST to create a favorite and DELETE to remove it. A duplicate POST caused by a retry is a separate case and should not silently cancel the favorite.

## Evidence

The learner evaluated the duplicate-favorite API behavior and explained their product expectation.
