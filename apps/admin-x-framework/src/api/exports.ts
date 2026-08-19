import {createMutation} from '../utils/api/hooks';

export type ExportComponents = {
    content?: boolean;
    members?: boolean;
    analytics?: boolean;
    themes?: boolean;
    routes?: boolean;
    media?: boolean;
};

export type ExportRequestPayload = {
    components: ExportComponents;
};

export const useRequestExport = createMutation<unknown, ExportRequestPayload>({
    method: 'POST',
    path: () => '/exports/',
    body: ({components}) => ({components}),
    // Not idempotent: each delivered request can schedule an archive and an
    // email, so a lost response must not trigger an automatic re-send.
    retry: false
});
