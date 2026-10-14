# Atlas dependency review

Compare the old and new npm lockfiles before the next Atlas dashboard release.

- Old snapshot: [[Old/package-lock.json]]
- New snapshot: [[New/package-lock.json]]
- Root package a moves from 1.0.0 to 1.0.1.
- The nested installation of a has its own row.
- The workspace link needs a separate check.

Run **Lockfile Upgrade Notes: Compare vault lockfiles**. Choose the two files, then select **Compare versions** and **Create report**.

The report records package versions. Use the package release notes and project tests to check compatibility.
