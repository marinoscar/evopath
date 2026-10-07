// =============================================================================
// TELEMETRY_APP_INFO adapter: who this application is (marinoscar/EnterpriseAppBase#703, PP-4.2)
// =============================================================================
//
// The slug (`APP_SLUG`: the default `app.instance.id`), the service name
// (`OTEL_SERVICE_NAME`, else `${APP_SLUG}-api`), the API version and the
// deploy document. The slice never imports `@app/shared`: product identity
// stays in the app.
// =============================================================================

import { Injectable } from '@nestjs/common';
import { APP_SLUG } from '@app/shared';

import { readDeployInfo, resolveDeployInfoPath } from '../../about/deploy-info';
import { resolveServiceName } from '../../common/otel/telemetry-identity';
import { resolveApiVersion } from '../../openapi/version';
import type { TelemetryAppInfo, TelemetryDeployInfo } from '@marinoscar/platform-api/telemetry';

@Injectable()
export class TelemetryAppInfoAdapter implements TelemetryAppInfo {
  readonly slug = APP_SLUG;

  serviceName(): string {
    return resolveServiceName();
  }

  apiVersion(): string {
    return resolveApiVersion();
  }

  readDeployInfo(): Promise<TelemetryDeployInfo> {
    return readDeployInfo(resolveDeployInfoPath());
  }
}
