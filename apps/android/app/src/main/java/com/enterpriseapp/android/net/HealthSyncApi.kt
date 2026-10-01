package com.enterpriseapp.android.net

import com.enterpriseapp.android.sync.SyncRequest
import com.enterpriseapp.android.sync.SyncResponse
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** `POST /api/health-sync/devices` body (strings ≤ 100; the API's schema is strict). */
@Serializable
data class RegisterDeviceRequest(
    val installationId: String,
    val name: String,
    val manufacturer: String? = null,
    val model: String? = null,
    val androidVersion: String? = null,
    val sdkInt: Int? = null,
    val appVersion: String? = null,
    val healthConnectVersion: String? = null,
    val packageName: String? = null,
    val signingSha256: String? = null,
    val timezone: String? = null,
)

/** The API's Device view (only the fields the phone uses are required). */
@Serializable
data class HealthSyncDevice(
    val id: String,
    val name: String? = null,
    val status: String? = null,
    val timezone: String? = null,
    val userTimezone: String? = null,
    val lastSeenAt: String? = null,
    val lastSyncAt: String? = null,
    val lastSyncStatus: String? = null,
    val lastError: String? = null,
    val tokenExpiresAt: String? = null,
)

@Serializable
data class UploadDiagnosticsRequest(val summary: String? = null, val report: JsonObject)

@Serializable
data class UploadDiagnosticsResponse(val id: String, val createdAt: String? = null)

/** Typed calls to `/api/health-sync` (all authenticated with the paired PAT). */
interface HealthSyncBackend {
    suspend fun registerDevice(request: RegisterDeviceRequest): ApiResult<HealthSyncDevice>
    suspend fun getDevice(deviceId: String): ApiResult<HealthSyncDevice>
    suspend fun sync(deviceId: String, request: SyncRequest): ApiResult<SyncResponse>
    suspend fun unpair(deviceId: String): ApiResult<JsonElement>
    suspend fun uploadDiagnostics(deviceId: String, request: UploadDiagnosticsRequest): ApiResult<UploadDiagnosticsResponse>
}

class HealthSyncApi(private val api: ApiClient) : HealthSyncBackend {
    override suspend fun registerDevice(request: RegisterDeviceRequest): ApiResult<HealthSyncDevice> =
        api.post(DEVICES, request, RegisterDeviceRequest.serializer(), HealthSyncDevice.serializer())

    override suspend fun getDevice(deviceId: String): ApiResult<HealthSyncDevice> =
        api.get("$DEVICES/${segment(deviceId)}", HealthSyncDevice.serializer())

    override suspend fun sync(deviceId: String, request: SyncRequest): ApiResult<SyncResponse> =
        api.post("$DEVICES/${segment(deviceId)}/sync", request, SyncRequest.serializer(), SyncResponse.serializer())

    override suspend fun unpair(deviceId: String): ApiResult<JsonElement> =
        api.delete("$DEVICES/${segment(deviceId)}?deleteEntries=false")

    override suspend fun uploadDiagnostics(
        deviceId: String,
        request: UploadDiagnosticsRequest,
    ): ApiResult<UploadDiagnosticsResponse> =
        api.post(
            "$DEVICES/${segment(deviceId)}/diagnostics",
            request,
            UploadDiagnosticsRequest.serializer(),
            UploadDiagnosticsResponse.serializer(),
        )

    companion object {
        const val DEVICES = "/api/health-sync/devices"

        /** Device ids are UUIDs; refuse anything that could alter the path. */
        private fun segment(id: String): String {
            require(id.matches(Regex("^[A-Za-z0-9-]{1,64}$"))) { "Invalid device id" }
            return id
        }
    }
}
