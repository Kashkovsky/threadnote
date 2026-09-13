#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>
#import <stdint.h>
#import <string.h>

static NSString *const kThreadnoteService = @"io.threadnote.graph.auth0.v1";
static const uint32_t kMaxValueBytes = 65536;
static const int32_t kInvalidInput = -1;
static const int32_t kOutputTooSmall = -2;

static NSString *accountString(const uint8_t *account, uint32_t accountLength) {
    if (account == NULL || accountLength != 64) return nil;
    for (uint32_t index = 0; index < accountLength; index++) {
        const uint8_t byte = account[index];
        if (!((byte >= '0' && byte <= '9') || (byte >= 'a' && byte <= 'f'))) return nil;
    }
    return [[NSString alloc] initWithBytes:account length:accountLength encoding:NSASCIIStringEncoding];
}

static NSDictionary *baseQuery(NSString *account) {
    LAContext *context = [LAContext new];
    context.interactionNotAllowed = YES;
    return @{
        (__bridge NSString *)kSecClass: (__bridge id)kSecClassGenericPassword,
        (__bridge NSString *)kSecAttrService: kThreadnoteService,
        (__bridge NSString *)kSecAttrAccount: account,
        (__bridge NSString *)kSecAttrSynchronizable: @NO,
        (__bridge NSString *)kSecUseAuthenticationContext: context,
    };
}

__attribute__((visibility("default")))
int32_t tn_graph_keychain_get(const uint8_t *account, uint32_t accountLength, uint8_t *output,
                              uint32_t outputCapacity, uint32_t *outputLength) {
    if (outputLength == NULL) return kInvalidInput;
    *outputLength = 0;
    if (output == NULL || outputCapacity == 0 || outputCapacity > kMaxValueBytes) return kInvalidInput;
    @autoreleasepool {
        NSString *validatedAccount = accountString(account, accountLength);
        if (validatedAccount == nil) return kInvalidInput;
        NSMutableDictionary *query = [baseQuery(validatedAccount) mutableCopy];
        query[(__bridge NSString *)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
        query[(__bridge NSString *)kSecReturnData] = @YES;
        CFTypeRef result = NULL;
        OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
        if (status != errSecSuccess) {
            if (result != NULL) CFRelease(result);
            return status;
        }
        if (result == NULL || CFGetTypeID(result) != CFDataGetTypeID()) {
            if (result != NULL) CFRelease(result);
            return kInvalidInput;
        }
        CFDataRef data = (CFDataRef)result;
        CFIndex length = CFDataGetLength(data);
        if (length < 0 || length > kMaxValueBytes || length > outputCapacity) {
            CFRelease(result);
            return kOutputTooSmall;
        }
        memcpy(output, CFDataGetBytePtr(data), (size_t)length);
        *outputLength = (uint32_t)length;
        CFRelease(result);
        return errSecSuccess;
    }
}

__attribute__((visibility("default")))
int32_t tn_graph_keychain_put(const uint8_t *account, uint32_t accountLength,
                              const uint8_t *value, uint32_t valueLength) {
    if (value == NULL || valueLength == 0 || valueLength > kMaxValueBytes) return kInvalidInput;
    @autoreleasepool {
        NSString *validatedAccount = accountString(account, accountLength);
        if (validatedAccount == nil) return kInvalidInput;
        NSData *bytes = [NSData dataWithBytes:value length:valueLength];
        NSDictionary *base = baseQuery(validatedAccount);
        NSMutableDictionary *addition = [base mutableCopy];
        addition[(__bridge NSString *)kSecValueData] = bytes;
        OSStatus status = SecItemAdd((__bridge CFDictionaryRef)addition, NULL);
        if (status == errSecDuplicateItem) {
            return SecItemUpdate((__bridge CFDictionaryRef)base,
                                 (__bridge CFDictionaryRef)@{(__bridge NSString *)kSecValueData: bytes});
        }
        return status;
    }
}

__attribute__((visibility("default")))
int32_t tn_graph_keychain_delete(const uint8_t *account, uint32_t accountLength) {
    @autoreleasepool {
        NSString *validatedAccount = accountString(account, accountLength);
        if (validatedAccount == nil) return kInvalidInput;
        OSStatus status = SecItemDelete((__bridge CFDictionaryRef)baseQuery(validatedAccount));
        return status == errSecItemNotFound ? errSecSuccess : status;
    }
}
