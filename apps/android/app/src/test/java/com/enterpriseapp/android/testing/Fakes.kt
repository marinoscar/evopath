package com.enterpriseapp.android.testing

import com.enterpriseapp.android.healthconnect.DailyAggregate
import com.enterpriseapp.android.healthconnect.HcAvailability
import com.enterpriseapp.android.healthconnect.HcBloodPressure
import com.enterpriseapp.android.healthconnect.HcDataType
import com.enterpriseapp.android.healthconnect.HcExerciseSession
import com.enterpriseapp.android.healthconnect.HcSample
import com.enterpriseapp.android.healthconnect.HcSleepSession
import com.enterpriseapp.android.healthconnect.HcTypeInventory
import com.enterpriseapp.android.healthconnect.HealthConnectGateway
import com.enterpriseapp.android.healthconnect.HealthPermissions
import com.enterpriseapp.android.net.ApiError
import com.enterpriseapp.android.net.ApiResult
import com.enterpriseapp.android.net.HealthSyncBackend
import com.enterpriseapp.android.net.HealthSyncDevice
import com.enterpriseapp.android.net.RegisterDeviceRequest
import com.enterpriseapp.android.net.UploadDiagnosticsRequest
import com.enterpriseapp.android.net.UploadDiagnosticsResponse
import com.enterpriseapp.android.sync.SyncRequest
import com.enterpriseapp.android.sync.SyncResponse
import com.enterpriseapp.android.sync.SyncScheduling
import com.enterpriseapp.android.sync.SyncTrigger
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import java.time.Instant
import java.time.LocalDate

/** In-memory Health Connect with per-type data and per-type failures. */
class FakeHealthConnect : HealthConnectGateway {
    var availability = HcAvailability.AVAILABLE
    var granted: Set<String> = HealthPermissions.ALL_DATA.toSet() + HealthPermissions.READ_HEALTH_DATA_IN_BACKGROUND
    var backgroundAvailable = true
    var version = "system"
    var grantedError: Exception? = null
    val failures = mutableMapOf<HcDataType, Exception>()
    val reads = mutableListOf<HcDataType>()

    var steps = listOf<DailyAggregate>()
    var heartRate = listOf<DailyAggregate>()
    var sessions = listOf<HcExerciseSession>()
    var distance: Double? = null
    var resting = listOf<HcSample>()
    var hrv = listOf<HcSample>()
    var weight = listOf<HcSample>()
    var bodyFat = listOf<HcSample>()
    var bloodPressure = listOf<HcBloodPressure>()
    var sleep = listOf<HcSleepSession>()

    private fun <T> read(type: HcDataType, value: T): T {
        reads += type
        failures[type]?.let { throw it }
        return value
    }

    override fun availability() = availability
    override fun providerVersion() = version
    override fun isBackgroundReadAvailable() = backgroundAvailable
    override suspend fun grantedPermissions(): Set<String> {
        if (grantedDelayMs > 0) kotlinx.coroutines.delay(grantedDelayMs)
        return grantedError?.let { throw it } ?: granted
    }
    override suspend fun dailySteps(from: LocalDate, to: LocalDate) = read(HcDataType.STEPS, steps)
    override suspend fun dailyHeartRateAvg(from: LocalDate, to: LocalDate) = read(HcDataType.HEART_RATE, heartRate)
    override suspend fun exerciseSessions(from: Instant, to: Instant) = read(HcDataType.EXERCISE, sessions)
    override suspend fun distanceMeters(from: Instant, to: Instant) = read(HcDataType.DISTANCE, distance)
    override suspend fun restingHeartRate(from: Instant, to: Instant) = read(HcDataType.RESTING_HEART_RATE, resting)
    override suspend fun heartRateVariability(from: Instant, to: Instant) = read(HcDataType.HRV, hrv)
    override suspend fun weight(from: Instant, to: Instant) = read(HcDataType.WEIGHT, weight)
    override suspend fun bodyFat(from: Instant, to: Instant) = read(HcDataType.BODY_FAT, bodyFat)
    override suspend fun bloodPressure(from: Instant, to: Instant) = read(HcDataType.BLOOD_PRESSURE, bloodPressure)
    override suspend fun sleepSessions(from: Instant, to: Instant) = read(HcDataType.SLEEP, sleep)
    val inventories = mutableMapOf<HcDataType, HcTypeInventory>()
    val inventoryFailures = mutableMapOf<HcDataType, Exception>()
    var grantedDelayMs = 0L

    override suspend fun inventory(type: HcDataType, from: Instant, to: Instant, cap: Int): HcTypeInventory {
        inventoryFailures[type]?.let { throw it }
        return inventories[type] ?: HcTypeInventory(type, 0, false, null, emptyList())
    }
}

/** Scripted `/api/health-sync` backend that records every request. */
class FakeBackend : HealthSyncBackend {
    val syncRequests = mutableListOf<SyncRequest>()
    val syncResults = ArrayDeque<ApiResult<SyncResponse>>()
    val registrations = mutableListOf<RegisterDeviceRequest>()
    var registerResult: ApiResult<HealthSyncDevice> = ApiResult.Success(HealthSyncDevice(id = "dev-1"), 200)
    var unpairResult: ApiResult<JsonElement> = ApiResult.Success(JsonNull, 204)
    val unpaired = mutableListOf<String>()

    override suspend fun registerDevice(request: RegisterDeviceRequest): ApiResult<HealthSyncDevice> {
        registrations += request
        return registerResult
    }

    var deviceResult: ApiResult<HealthSyncDevice>? = null
    val uploads = mutableListOf<UploadDiagnosticsRequest>()
    var uploadResult: ApiResult<UploadDiagnosticsResponse> = ApiResult.Success(UploadDiagnosticsResponse("r1"), 201)

    override suspend fun getDevice(deviceId: String): ApiResult<HealthSyncDevice> =
        deviceResult ?: ApiResult.Success(HealthSyncDevice(id = deviceId), 200)

    override suspend fun sync(deviceId: String, request: SyncRequest): ApiResult<SyncResponse> {
        syncRequests += request
        return syncResults.removeFirstOrNull() ?: ApiResult.Success(SyncResponse(runId = "run-${syncRequests.size}"), 200)
    }

    override suspend fun unpair(deviceId: String): ApiResult<JsonElement> {
        unpaired += deviceId
        return unpairResult
    }

    override suspend fun uploadDiagnostics(deviceId: String, request: UploadDiagnosticsRequest): ApiResult<UploadDiagnosticsResponse> {
        uploads += request
        return uploadResult
    }

    companion object {
        fun httpError(status: Int, reason: String? = null) =
            ApiResult.Failure(ApiError(ApiError.Kind.HTTP, status, ApiErrorCodes.forStatus(status), "HTTP $status", reason = reason))

        fun networkError() = ApiResult.Failure(ApiError(ApiError.Kind.NETWORK, message = "Could not reach the server"))
    }
}

private object ApiErrorCodes {
    fun forStatus(status: Int) = com.enterpriseapp.android.net.ApiClient.codeForStatus(status)
}

class FakeScheduler : SyncScheduling {
    var periodic = 0
    val now = mutableListOf<SyncTrigger>()
    var cancelled = 0
    override fun ensurePeriodic() {
        periodic++
    }
    override fun syncNow(trigger: SyncTrigger) {
        now += trigger
    }
    override fun cancelAll() {
        cancelled++
    }
}
