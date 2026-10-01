package com.evopath.android.pairing

import com.evopath.android.auth.SharedPrefsTokenStore
import com.evopath.android.net.ApiResult
import com.evopath.android.net.RegisterDeviceRequest
import com.evopath.android.sync.PrefsSyncStateStore
import com.evopath.android.sync.SyncTrigger
import com.evopath.android.testing.FakeBackend
import com.evopath.android.testing.FakeScheduler
import com.evopath.android.testing.FakeSharedPreferences
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class PairingManagerTest {
    private val grant = DeviceCodeGrant("dc", "ABCD-1234", "https://e/activate", "https://e/activate?code=ABCD-1234", 900, 5)
    private val tokens = SharedPrefsTokenStore(FakeSharedPreferences())
    private val state = PrefsSyncStateStore(FakeSharedPreferences())
    private val backend = FakeBackend()
    private val scheduler = FakeScheduler()

    private fun manager(poll: ApiResult<DeviceCredential>): PairingManager {
        val transport = object : DeviceFlowTransport {
            override suspend fun requestCode(clientInfo: DeviceClientInfo) = ApiResult.Success(grant, 200)
            override suspend fun pollToken(deviceCode: String) = poll
        }
        return PairingManager(
            transport = transport,
            poller = DeviceFlowPoller(transport, sleep = {}),
            backend = backend,
            tokens = tokens,
            state = state,
            scheduler = scheduler,
            clientInfo = { DeviceClientInfo("Pixel · Health sync", "EvoPath-Android/0.1.0") },
            deviceRegistration = { RegisterDeviceRequest(installationId = it, name = "Pixel · Health sync") },
            clock = { Instant.parse("2026-10-01T00:00:00Z") },
        )
    }

    private val approved = ApiResult.Success(
        DeviceCredential("pat_new", credentialType = "pat", expiresAt = "2026-12-30T00:00:00Z"),
        200,
    )

    @Test fun `approval stores the PAT, registers this installation and schedules sync`() = runBlocking {
        state.pairingExpired = true
        state.lastSuccessfulSyncAt = Instant.EPOCH
        val events = mutableListOf<PairingEvent>()
        val result = manager(approved).pair { events += it }

        assertEquals(PairingResult.Paired("dev-1", Instant.parse("2026-12-30T00:00:00Z")), result)
        assertEquals(PairingEvent.CodeReady(grant), events.first())
        assertTrue(PairingEvent.Registering in events)
        assertEquals("pat_new", tokens.token)
        assertEquals("dev-1", tokens.deviceId)
        assertEquals(tokens.installationId, backend.registrations.single().installationId)
        assertFalse(state.pairingExpired)
        assertNull("re-pairing backfills 30 days", state.lastSuccessfulSyncAt)
        assertEquals(1, scheduler.periodic)
        assertEquals(listOf(SyncTrigger.INITIAL), scheduler.now)
    }

    @Test fun `a failed registration keeps the token so it can be retried`() = runBlocking {
        backend.registerResult = FakeBackend.networkError()
        val result = manager(approved).pair {}
        assertEquals(true, (result as PairingResult.Failed).canRetryRegistration)
        assertEquals("pat_new", tokens.token)
        assertNull(tokens.deviceId)

        backend.registerResult = ApiResult.Success(com.evopath.android.net.HealthSyncDevice("dev-9"), 200)
        assertTrue(manager(approved).register() is PairingResult.Paired)
        assertEquals("dev-9", tokens.deviceId)
    }

    @Test fun `denial saves nothing`() = runBlocking {
        val denied = ApiResult.Failure(
            com.evopath.android.net.ApiError(com.evopath.android.net.ApiError.Kind.HTTP, 400, message = "x", oauthError = "access_denied"),
        )
        assertTrue(manager(denied).pair {} is PairingResult.Failed)
        assertFalse(tokens.isPaired)
        assertTrue(backend.registrations.isEmpty())
    }

    @Test fun `unpair deletes the device on the server and forgets it locally`() = runBlocking {
        tokens.setToken("pat_x", null)
        tokens.setDeviceId("dev-1")
        assertEquals(UnpairResult.Done, manager(approved).unpair())
        assertEquals(listOf("dev-1"), backend.unpaired)
        assertFalse(tokens.isPaired)
        assertEquals(1, scheduler.cancelled)
    }

    @Test fun `unpair offers a local-only removal when the server is unreachable`() = runBlocking {
        tokens.setToken("pat_x", null)
        tokens.setDeviceId("dev-1")
        backend.unpairResult = FakeBackend.networkError()
        val m = manager(approved)
        assertTrue(m.unpair() is UnpairResult.ServerUnreachable)
        assertTrue(tokens.isPaired)
        assertEquals(UnpairResult.Done, m.unpair(forgetLocallyOnFailure = true))
        assertFalse(tokens.isPaired)
    }

    @Test fun `a server that already forgot the device counts as unpaired`() = runBlocking {
        tokens.setToken("pat_x", null)
        tokens.setDeviceId("dev-1")
        backend.unpairResult = FakeBackend.httpError(401)
        assertEquals(UnpairResult.Done, manager(approved).unpair())
        assertFalse(tokens.isPaired)
    }
}
