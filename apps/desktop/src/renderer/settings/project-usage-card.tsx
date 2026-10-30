import type { DesktopSource } from '@crewkite/client';
import type { ProjectPage } from '@crewkite/contracts';
import { useState } from 'react';
import { AnalyticsView } from '../analytics-view.tsx';
import type { ThreadSource } from '../thread/commands.ts';

/**
 * The usage numbers of one project: every thread of it added up, with a row for each thread. The
 * controller derives them from the records it already keeps. A thread has the same numbers in
 * its inspector.
 */
export function ProjectUsageCard({
  source,
  projects,
}: {
  source: ThreadSource & Pick<DesktopSource, 'saveAnalytics'>;
  projects: ProjectPage['projects'];
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const projectId = chosen && projects.some((project) => project.id === chosen) ? chosen : null;
  return (
    <section className="st-card" aria-labelledby="settings-project-usage">
      <header className="st-card-head">
        <h2 id="settings-project-usage">Project usage</h2>
        <span className="st-detail">Read from this computer. Nothing is sent anywhere.</span>
      </header>
      <div className="st-rows">
        {projects.length === 0 ? (
          <p className="st-hint">No project is registered yet.</p>
        ) : (
          <div className="st-row">
            <div className="st-field">
              <label className="st-name" htmlFor="project-usage-pick">
                Project
              </label>
              <select
                id="project-usage-pick"
                value={projectId ?? ''}
                onChange={(event) => setChosen(event.target.value || null)}
              >
                <option value="">Choose a project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
        {projectId && (
          <div className="st-row">
            <AnalyticsView source={source} input={{ scope: 'project', projectId }} />
          </div>
        )}
      </div>
    </section>
  );
}
