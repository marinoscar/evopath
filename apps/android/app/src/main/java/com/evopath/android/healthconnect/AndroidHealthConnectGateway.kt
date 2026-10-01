package com.evopath.android.healthconnect

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.records.BloodPressureRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.AggregateGroupByPeriodRequest
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Instant
import java.time.LocalDate
import java.time.Period
import kotlin.reflect.KClass

/** [HealthConnectGateway] over the Jetpack Health Connect client. */
class AndroidHealthConnectGateway(context: Context) : HealthConnectGateway {
    private val appContext = context.applicationContext

    /** Created on first use; [HealthConnectClient.getOrCreate] throws when the SDK is unavailable. */
    private val client: HealthConnectClient by lazy { HealthConnectClient.getOrCreate(appContext) }

    override fun availability(): HcAvailability =
        when (HealthConnectClient.getSdkStatus(appContext)) {
            HealthConnectClient.SDK_AVAILABLE -> HcAvailability.AVAILABLE
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> HcAvailability.UPDATE_REQUIRED
            else -> HcAvailability.NOT_SUPPORTED
        }

    override fun providerVersion(): String = providerApkVersion(appContext) ?: "system"

    override fun isBackgroundReadAvailable(): Boolean = runCatching {
        availability() == HcAvailability.AVAILABLE &&
            client.features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND) ==
            HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
    }.getOrDefault(false)

    override suspend fun grantedPermissions(): Set<String> = client.permissionController.getGrantedPermissions()

    override suspend fun dailySteps(from: LocalDate, to: LocalDate): List<DailyAggregate> {
        val groups = client.aggregateGroupByPeriod(
            AggregateGroupByPeriodRequest(setOf(StepsRecord.COUNT_TOTAL), localDays(from, to), Period.ofDays(1)),
        )
        return groups.mapNotNull { group ->
            val total = group.result[StepsRecord.COUNT_TOTAL] ?: return@mapNotNull null
            DailyAggregate(group.startTime.toLocalDate(), total.toDouble(), group.result.dataOrigins.packages())
        }
    }

    override suspend fun dailyHeartRateAvg(from: LocalDate, to: LocalDate): List<DailyAggregate> {
        val groups = client.aggregateGroupByPeriod(
            AggregateGroupByPeriodRequest(setOf(HeartRateRecord.BPM_AVG), localDays(from, to), Period.ofDays(1)),
        )
        return groups.mapNotNull { group ->
            val avg = group.result[HeartRateRecord.BPM_AVG] ?: return@mapNotNull null
            DailyAggregate(group.startTime.toLocalDate(), avg.toDouble(), group.result.dataOrigins.packages())
        }
    }

    override suspend fun exerciseSessions(from: Instant, to: Instant): List<HcExerciseSession> =
        readAll(ExerciseSessionRecord::class, HcDataType.EXERCISE, from, to).map {
            HcExerciseSession(
                id = it.metadata.id,
                exerciseType = it.exerciseType,
                start = it.startTime,
                end = it.endTime,
                title = it.title,
                origin = it.metadata.dataOrigin.packageName,
                startZoneOffset = it.startZoneOffset,
            )
        }

    override suspend fun distanceMeters(from: Instant, to: Instant): Double? {
        val result = client.aggregate(AggregateRequest(setOf(DistanceRecord.DISTANCE_TOTAL), TimeRangeFilter.between(from, to)))
        return result[DistanceRecord.DISTANCE_TOTAL]?.inMeters
    }

    override suspend fun restingHeartRate(from: Instant, to: Instant): List<HcSample> =
        readAll(RestingHeartRateRecord::class, HcDataType.RESTING_HEART_RATE, from, to).map {
            HcSample(it.metadata.id, it.time, it.beatsPerMinute.toDouble(), it.metadata.dataOrigin.packageName)
        }

    override suspend fun heartRateVariability(from: Instant, to: Instant): List<HcSample> =
        readAll(HeartRateVariabilityRmssdRecord::class, HcDataType.HRV, from, to).map {
            HcSample(it.metadata.id, it.time, it.heartRateVariabilityMillis, it.metadata.dataOrigin.packageName)
        }

    override suspend fun weight(from: Instant, to: Instant): List<HcSample> =
        readAll(WeightRecord::class, HcDataType.WEIGHT, from, to).map {
            HcSample(it.metadata.id, it.time, it.weight.inKilograms, it.metadata.dataOrigin.packageName)
        }

    override suspend fun bodyFat(from: Instant, to: Instant): List<HcSample> =
        readAll(BodyFatRecord::class, HcDataType.BODY_FAT, from, to).map {
            HcSample(it.metadata.id, it.time, it.percentage.value, it.metadata.dataOrigin.packageName)
        }

    override suspend fun bloodPressure(from: Instant, to: Instant): List<HcBloodPressure> =
        readAll(BloodPressureRecord::class, HcDataType.BLOOD_PRESSURE, from, to).map {
            HcBloodPressure(
                id = it.metadata.id,
                time = it.time,
                systolicMmHg = it.systolic.inMillimetersOfMercury,
                diastolicMmHg = it.diastolic.inMillimetersOfMercury,
                origin = it.metadata.dataOrigin.packageName,
            )
        }

    override suspend fun sleepSessions(from: Instant, to: Instant): List<HcSleepSession> =
        readAll(SleepSessionRecord::class, HcDataType.SLEEP, from, to).map { record ->
            HcSleepSession(
                id = record.metadata.id,
                start = record.startTime,
                end = record.endTime,
                stages = record.stages.map { HcSleepStage(it.startTime, it.endTime, it.stage) },
                origin = record.metadata.dataOrigin.packageName,
                title = record.title,
            )
        }

    override suspend fun inventory(type: HcDataType, from: Instant, to: Instant, cap: Int): HcTypeInventory {
        val counts = linkedMapOf<String, Int>()
        val latestBySource = mutableMapOf<String, Instant>()
        var total = 0
        var capped = false
        var token: String? = null
        page@ do {
            val response = client.readRecords(
                ReadRecordsRequest(
                    recordType = recordClass(type),
                    timeRangeFilter = TimeRangeFilter.between(from, to),
                    pageSize = minOf(PAGE_SIZE, cap.coerceAtLeast(1)),
                    pageToken = token,
                ),
            )
            for (record in response.records) {
                if (total >= cap) {
                    capped = true
                    break@page
                }
                total += 1
                val pkg = record.metadata.dataOrigin.packageName
                counts[pkg] = (counts[pkg] ?: 0) + 1
                val time = recordTime(record)
                if (time != null && (latestBySource[pkg]?.isBefore(time) != false)) latestBySource[pkg] = time
            }
            token = response.pageToken?.takeIf { it.isNotEmpty() }
            if (total >= cap && token != null) {
                capped = true
                break
            }
        } while (token != null)
        val sources = counts.map { (pkg, n) -> HcSourceCount(pkg, n, latestBySource[pkg]) }.sortedByDescending { it.recordCount }
        return HcTypeInventory(type, total, capped, latestBySource.values.maxOrNull(), sources)
    }

    private suspend fun <T : Record> readAll(recordType: KClass<T>, type: HcDataType, from: Instant, to: Instant): List<T> {
        val out = ArrayList<T>()
        var token: String? = null
        do {
            val response = client.readRecords(
                ReadRecordsRequest(
                    recordType = recordType,
                    timeRangeFilter = TimeRangeFilter.between(from, to),
                    pageSize = PAGE_SIZE,
                    pageToken = token,
                ),
            )
            out += response.records
            if (out.size > MAX_RECORDS_PER_TYPE) throw TooManyRecordsException(type, MAX_RECORDS_PER_TYPE)
            token = response.pageToken?.takeIf { it.isNotEmpty() }
        } while (token != null)
        return out
    }

    private fun localDays(from: LocalDate, to: LocalDate): TimeRangeFilter =
        TimeRangeFilter.between(from.atStartOfDay(), to.plusDays(1).atStartOfDay())

    private fun Set<androidx.health.connect.client.records.metadata.DataOrigin>.packages(): Set<String> =
        mapTo(linkedSetOf()) { it.packageName }

    companion object {
        const val PROVIDER_PACKAGE = "com.google.android.apps.healthdata"
        private const val PAGE_SIZE = 1000

        /** Safety cap per type and sync; far above a month of real data. */
        const val MAX_RECORDS_PER_TYPE = 20_000

        fun recordClass(type: HcDataType): KClass<out Record> = when (type) {
            HcDataType.STEPS -> StepsRecord::class
            HcDataType.EXERCISE -> ExerciseSessionRecord::class
            HcDataType.DISTANCE -> DistanceRecord::class
            HcDataType.HEART_RATE -> HeartRateRecord::class
            HcDataType.RESTING_HEART_RATE -> RestingHeartRateRecord::class
            HcDataType.HRV -> HeartRateVariabilityRmssdRecord::class
            HcDataType.WEIGHT -> WeightRecord::class
            HcDataType.BODY_FAT -> BodyFatRecord::class
            HcDataType.BLOOD_PRESSURE -> BloodPressureRecord::class
            HcDataType.SLEEP -> SleepSessionRecord::class
        }

        // InstantaneousRecord / IntervalRecord are library-internal; match the concrete types.
        private fun recordTime(record: Record): Instant? = when (record) {
            is StepsRecord -> record.endTime
            is ExerciseSessionRecord -> record.endTime
            is DistanceRecord -> record.endTime
            is HeartRateRecord -> record.endTime
            is SleepSessionRecord -> record.endTime
            is RestingHeartRateRecord -> record.time
            is HeartRateVariabilityRmssdRecord -> record.time
            is WeightRecord -> record.time
            is BodyFatRecord -> record.time
            is BloodPressureRecord -> record.time
            else -> null
        }

        /** `versionName` of the Health Connect APK, or null when it is not installed. */
        fun providerApkVersion(context: Context): String? = try {
            val pm = context.packageManager
            val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.getPackageInfo(PROVIDER_PACKAGE, PackageManager.PackageInfoFlags.of(0))
            } else {
                @Suppress("DEPRECATION")
                pm.getPackageInfo(PROVIDER_PACKAGE, 0)
            }
            info.versionName ?: "unknown"
        } catch (_: PackageManager.NameNotFoundException) {
            null
        }
    }
}
