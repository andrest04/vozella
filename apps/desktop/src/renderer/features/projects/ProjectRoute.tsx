import { useParams } from '@tanstack/react-router';
import { ProjectPage } from './ProjectPage';

/** `/projects/<id>`: the page of one project. */
export function ProjectRoute() {
  const { projectId } = useParams({ from: '/projects/$projectId' });
  return <ProjectPage projectId={projectId} />;
}
