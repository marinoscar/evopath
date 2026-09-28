import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO representing a device session
 */
export class DeviceSessionDto {
  @ApiProperty({
    description: 'Device session ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id!: string;

  @ApiProperty({
    description: 'User verification code',
    example: 'ABCD-1234',
  })
  userCode!: string;

  @ApiProperty({
    description:
      'Device authorization status. `approved` means approved but not yet collected by the ' +
      'device; `expired` means the device collected its credential (see `collectedAt`). ' +
      'Denied and pending requests are never listed.',
    enum: ['pending', 'approved', 'denied', 'expired'],
    example: 'approved',
  })
  status!: string;

  @ApiProperty({
    description: 'Client information',
    required: false,
  })
  clientInfo?: Record<string, any>;

  @ApiProperty({
    description:
      'When the device code was created, i.e. when the device started the flow. The approval ' +
      'instant is not recorded separately.',
    example: '2026-01-22T10:30:00Z',
  })
  createdAt!: string;

  @ApiProperty({
    description:
      'When the device CODE expires (`DEVICE_CODE_EXPIRY_MINUTES`, 15 minutes by default) — ' +
      'the deadline for the device to redeem it. Not the lifetime of the credential it ' +
      'receives, which is governed by `DEVICE_TOKEN_EXPIRY_DAYS` or `DEVICE_PAT_EXPIRY_DAYS`.',
    example: '2026-01-22T10:45:00Z',
  })
  expiresAt!: string;

  @ApiProperty({
    description:
      'When the device collected its credential on `POST /auth/device/token`. `null` while ' +
      'the request is approved but not yet collected.',
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-01-22T10:32:00Z',
  })
  collectedAt!: string | null;

  @ApiProperty({
    description:
      'When the collected credential expires (`DEVICE_TOKEN_EXPIRY_DAYS` for a session ' +
      'credential, `DEVICE_PAT_EXPIRY_DAYS` for a personal access token). The session leaves ' +
      'this list once this passes. `null` until collection.',
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-01-29T10:32:00Z',
  })
  credentialExpiresAt!: string | null;

  @ApiProperty({
    description:
      'Kind of credential the device collected: `session` (access + refresh token) or `pat` ' +
      '(personal access token). `null` until collection. Revoking the session revokes that ' +
      'credential either way.',
    // `null` listed explicitly: under OpenAPI 3.1 `nullable` widens `type` but
    // not `enum`, so without it a `null` value would fail the schema.
    enum: ['pat', 'session', null],
    nullable: true,
    example: 'session',
  })
  credentialType!: 'pat' | 'session' | null;
}

/**
 * Paginated response DTO for device sessions
 */
export class DeviceSessionsResponseDto {
  @ApiProperty({
    description: 'Device sessions on this page, newest first',
    type: [DeviceSessionDto],
  })
  sessions!: DeviceSessionDto[];

  @ApiProperty({
    description: 'Total number of listed device sessions across all pages',
    example: 10,
  })
  total!: number;

  @ApiProperty({
    description: 'Current page number',
    example: 1,
  })
  page!: number;

  @ApiProperty({
    description: 'Page size',
    example: 10,
  })
  limit!: number;
}
